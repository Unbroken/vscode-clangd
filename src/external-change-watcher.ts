// Reparse open files when C-family sources change on disk outside the editor.
//
// clangd only rebuilds an open file's preamble (and so notices changed
// headers) when that file is edited or when any file is saved. Files changed by
// other tools, e.g. an AI agent in a terminal, produce neither: VS Code reloads
// open files from disk, which is a `didChange` for that file only, and headers
// that aren't open produce no notification at all. Until something else
// triggers a reparse, open files keep diagnostics computed against the old
// headers.
//
// This watcher sends a `didSave` after such changes. clangd treats any
// `didSave` as a hint that files on disk changed, and reparses all open files,
// rebuilding the preambles whose dependencies changed (clangd 11+).
//
// A clangd that reparses open files on workspace/didChangeWatchedFiles itself
// watches the files with its own extensions in the workspace folders. The
// watcher then only watches what clangd doesn't: other files associated with
// its languages, directories, and the directories of open files outside the
// workspace folders. It reports their changes with the same notification,
// which unlike a didSave also rebuilds the ASTs of open files whose preambles
// are unchanged.

import * as fs from 'fs';
import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';

import {ClangdContext, isClangdDocument} from './clangd-context';
import * as config from './config';

// Server capability advertised by a clangd that reparses open files on
// workspace/didChangeWatchedFiles itself.
interface ClangdServerCapabilities {
  fileWatching?: {reparseOpenFiles?: boolean;};
}

// Extensions of C, C++, Objective-C and CUDA sources and headers, in addition
// to those that extensions associate with these languages.
const defaultExtensions = [
  'c',   'i',   'cc',  'cp',   'cpp',  'cxx', 'c++', 'ii',  'cppm', 'ccm',
  'cxxm', 'c++m', 'ixx', 'mpp', 'mxx', 'h',  'hh',  'hp',  'hpp',  'hxx',
  'h++', 'inc', 'inl', 'ipp',  'tcc',  'tpp', 'txx', 'm',   'mm',   'mi',
  'mii', 'cu',  'cuh'
];

// The extensions of the files such a clangd watches itself, in the workspace
// folders (ClangdLSPServer::onInitialized).
const serverWatchedExtensions = new Set([...defaultExtensions, 'def']);

const clangdLanguages =
    new Set(['c', 'cpp', 'cuda-cpp', 'objective-c', 'objective-cpp']);

// Wait this long after the last change before reparsing, so that a tool
// writing many files causes one reparse.
const debounceMs = 200;
// How long to wait for VS Code to reload a changed open file before reparsing
// anyway.
const reloadTimeoutMs = 2000;

export function activate(context: ClangdContext) {
  context.client.registerFeature(new ExternalChangeWatcherFeature(context));
}

class ExternalChangeWatcherFeature implements vscodelc.StaticFeature {
  private watcher?: ExternalChangeWatcher;
  // Capabilities of the running server, if any.
  private capabilities?: ClangdServerCapabilities;

  constructor(private context: ClangdContext) {
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
          if (e.affectsConfiguration('clangd.reparseOnExternalChanges'))
            this.update();
        }),
        {dispose: () => this.clear()});
  }
  fillClientCapabilities(_capabilities: vscodelc.ClientCapabilities) {}

  // Called again with the new server's capabilities when the client restarts
  // the server, e.g. after a crash.
  async initialize(capabilities: vscodelc.ServerCapabilities,
                   _documentSelector: vscodelc.DocumentSelector|undefined) {
    this.capabilities = capabilities as ClangdServerCapabilities;
    await this.update();
  }
  getState(): vscodelc.FeatureState { return {kind: 'static'}; }
  clear() {
    this.capabilities = undefined;
    this.stopWatching();
  }

  private async update() {
    const capabilities = this.capabilities;
    const enabled = capabilities !== undefined &&
                    await config.get<boolean>('reparseOnExternalChanges');
    // The server may have stopped or restarted while reading the setting.
    if (capabilities !== this.capabilities)
      return;
    const serverWatches = !!capabilities?.fileWatching?.reparseOpenFiles;
    if (!enabled || this.watcher?.serverWatches !== serverWatches)
      this.stopWatching();
    if (enabled && !this.watcher)
      this.watcher = new ExternalChangeWatcher(this.context, serverWatches);
  }

  private stopWatching() {
    this.watcher?.dispose();
    this.watcher = undefined;
  }
}

function isLetter(c: string): boolean {
  return c.toLowerCase() !== c.toUpperCase();
}

// Returns the index of the ] that closes the brackets that open at `start`, or
// -1. Like in VS Code's globs, a ] first in the brackets is one of the
// characters they match.
function closingBracket(glob: string, start: number): number {
  return glob.indexOf(']', glob[start + 1] === ']' ? start + 2 : start + 1);
}

// Makes a glob match case-insensitively, like VS Code's language detection,
// also on case-sensitive file systems. Character classes gain the other case of
// their letters and ranges of letters, so [a-z] becomes [a-zA-Z], and [!a-z]
// excludes both cases.
function anyCase(glob: string): string {
  let result = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    const end = c === '[' ? closingBracket(glob, i) : -1;
    if (end < 0) {
      result += isLetter(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c;
      continue;
    }
    let body = glob.slice(i + 1, end);
    const negation = /^[!^]/.test(body) ? body[0] : '';
    body = body.slice(negation.length);
    let members = '';
    for (let j = 0; j < body.length; j++) {
      const first = body[j];
      if (body[j + 1] === '-' && j + 2 < body.length) {
        const last = body[j + 2];
        members += `${first}-${last}`;
        const sameCase = (a: string, b: string) =>
            a === a.toLowerCase() && b === b.toLowerCase() ||
            a === a.toUpperCase() && b === b.toUpperCase();
        if (isLetter(first) && isLetter(last) && sameCase(first, last)) {
          const swap = (letter: string) => letter === letter.toLowerCase()
                                               ? letter.toUpperCase()
                                               : letter.toLowerCase();
          members += `${swap(first)}-${swap(last)}`;
        }
        j += 2;
      } else {
        members += isLetter(first) ? first.toLowerCase() + first.toUpperCase()
                                   : first;
      }
    }
    result += `[${negation}${members}]`;
    i = end;
  }
  return result;
}

type Associations = {[pattern: string]: string};

// Returns the files that installed extensions, including the built-in ones,
// associate with clangd's languages, in the format of files.associations.
function contributedAssociations(): Associations {
  const associations: Associations = {};
  for (const extension of vscode.extensions.all) {
    const languages = extension.packageJSON?.contributes?.languages;
    if (!Array.isArray(languages))
      continue;
    for (const language of languages) {
      if (!clangdLanguages.has(language?.id))
        continue;
      for (const fileExtension of language.extensions ?? [])
        associations[`*${fileExtension}`] = language.id;
      for (const name of [...language.filenames ?? [],
                          ...language.filenamePatterns ?? []])
        associations[name] = language.id;
    }
  }
  return associations;
}

// The files that clangd parses: their extensions, and other glob patterns,
// which match file names unless they contain a slash.
interface WatchedFiles {
  extensions: string[];
  patterns: string[];
}

// Returns the files that clangd parses, given associations like those of the
// files.associations setting.
export function watchedFiles(associations: (Associations|undefined)[]):
    WatchedFiles {
  const extensions = new Set(defaultExtensions);
  const patterns = new Set<string>();
  const entries = associations.flatMap(a => Object.entries(a ?? {}));
  for (const [pattern, language] of entries) {
    if (!clangdLanguages.has(language))
      continue;
    const extension = /^\*\.([^*?/\\{}[\]]+)$/.exec(pattern)?.[1];
    if (extension)
      extensions.add(extension.toLowerCase());
    else
      patterns.add(pattern);
  }
  return {extensions: [...extensions], patterns: [...patterns]};
}

// Returns a regular expression matching paths like a glob, case-insensitively
// like VS Code's language detection: ** matches any number of directories, *
// and ? match within one, and braces and brackets list alternatives. An invalid
// glob matches nothing, as in VS Code.
export function globToRegExp(glob: string): RegExp {
  let source = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      // **/ matches no directory or any of them, and a trailing ** anything
      const slash = glob[i + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') {
      source += '[^/]*';
    } else if (c === '?') {
      source += '[^/]';
    } else if (c === '[') {
      const end = closingBracket(glob, i);
      if (end < 0) {
        source += '\\[';
        continue;
      }
      const body = glob.slice(i + 1, end)
                       .replace(/[\\\]]/g, '\\$&')
                       .replace(/^!/, '^');
      source += `[${body}]`;
      i = end;
    } else if (c === '{') {
      ++braces;
      source += '(?:';
    } else if (c === '}' && braces > 0) {
      --braces;
      source += ')';
    } else if (c === ',' && braces > 0) {
      source += '|';
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  try {
    return new RegExp(`^${source}$`, 'i');
  } catch {
    return /(?!)/;
  }
}

// Whether a deleted path can have been a directory, which can be reported as a
// single event for the directory when it's moved. The type of a deleted path
// can't be told, but files without an extension are rare outside of
// directories that clangd's languages associate, while deleted files with one,
// such as the temporary files that compilers rename to their outputs, are
// common. Of directories with an extension, frameworks contain headers.
function mayBeDirectory(uri: vscode.Uri): boolean {
  const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
  const extension = /.\.([^.]+)$/.exec(name)?.[1]?.toLowerCase();
  return extension === undefined || extension === 'framework';
}

// Returns a glob matching the names of files with one of the extensions.
function extensionsGlob(extensions: string[]): string {
  const globs = extensions.map(anyCase);
  return globs.length === 1 ? `*.${globs[0]}` : `*.{${globs.join(',')}}`;
}

class ExternalChangeWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private watchers: vscode.FileSystemWatcher[] = [];
  // The files to watch, and the watchers of the directories of open files
  // outside the workspace folders, by directory, and of open files that the
  // workspace's watchers don't watch, by file.
  private files: WatchedFiles = {extensions: [], patterns: []};
  private readonly directoryWatchers =
      new Map<string, vscode.FileSystemWatcher[]>();
  private readonly changed =
      new Map<string, {uri: vscode.Uri; type: vscodelc.FileChangeType}>();
  private timer?: NodeJS.Timeout;
  private running = false;
  private disposed = false;

  // `serverWatches` is set when clangd watches the files with its own
  // extensions in the workspace folders itself.
  constructor(private context: ClangdContext,
              readonly serverWatches: boolean) {
    this.createWatchers();
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('files.associations'))
        this.createWatchers();
    }));
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(
        () => this.createWatchers()));
    this.disposables.push(
        vscode.extensions.onDidChange(() => this.createWatchers()));
    this.disposables.push(
        vscode.workspace.onDidOpenTextDocument(
            () => this.updateDirectoryWatchers()),
        vscode.workspace.onDidCloseTextDocument(
            () => this.updateDirectoryWatchers()));
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.watchers.forEach(watcher => watcher.dispose());
    this.disposeDirectoryWatchers();
    this.disposables.forEach(disposable => disposable.dispose());
  }

  private watch(pattern: vscode.GlobPattern,
                filter: (uri: vscode.Uri) => boolean = () => true):
      vscode.FileSystemWatcher {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onChange = (uri: vscode.Uri, type: vscodelc.FileChangeType) => {
      if (filter(uri))
        this.onChange(uri, type);
    };
    watcher.onDidChange(uri => onChange(uri, vscodelc.FileChangeType.Changed));
    watcher.onDidCreate(uri => onChange(uri, vscodelc.FileChangeType.Created));
    watcher.onDidDelete(uri => onChange(uri, vscodelc.FileChangeType.Deleted));
    return watcher;
  }

  // Watches for directories that are created, or deleted or moved, which can
  // be reported as single events for the directories, matching `pattern` and
  // `filter`. A directory or link replaced by another one can be reported as a
  // change. A link that changes was replaced, which is reported. With
  // `replacements`, the pattern is relative to a directory, whose directories
  // are known, and a replaced directory is reported too. A directory also
  // changes when its entries do, so a replacement is told apart by its
  // identity.
  private watchDirectories(pattern: vscode.GlobPattern,
                           filter: (uri: vscode.Uri) => boolean = () => true,
                           replacements = false): vscode.FileSystemWatcher {
    const watcher = vscode.workspace.createFileSystemWatcher(
        pattern, /*ignoreCreateEvents=*/ false, /*ignoreChangeEvents=*/ false);
    const identities = new Map<string, string>();
    const identity = async (uri: vscode.Uri) => {
      try {
        const stat = await fs.promises.lstat(uri.fsPath);
        return stat.isDirectory() || stat.isSymbolicLink()
                   ? `${stat.dev}:${stat.ino}`
                   : undefined;
      } catch {
        return undefined;
      }
    };
    if (replacements && pattern instanceof vscode.RelativePattern) {
      const base = pattern.baseUri;
      vscode.workspace.fs.readDirectory(base).then(async entries => {
        for (const [name] of entries) {
          const uri = vscode.Uri.joinPath(base, name);
          const key = uri.toString();
          if (!filter(uri) || identities.has(key))
            continue;
          const current = await identity(uri);
          if (current && !identities.has(key))
            identities.set(key, current);
        }
      }, () => {});
    }
    watcher.onDidDelete(uri => {
      identities.delete(uri.toString());
      if (filter(uri) && mayBeDirectory(uri))
        this.onChange(uri, vscodelc.FileChangeType.Deleted);
    });
    watcher.onDidCreate(async uri => {
      if (!filter(uri))
        return;
      const current = await identity(uri);
      if (current)
        identities.set(uri.toString(), current);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.Directory)
          this.onChange(uri, vscodelc.FileChangeType.Created);
      } catch {
        // Already gone again.
      }
    });
    watcher.onDidChange(async uri => {
      if (!filter(uri))
        return;
      if (!replacements) {
        if (!mayBeDirectory(uri))
          return;
        try {
          if ((await fs.promises.lstat(uri.fsPath)).isSymbolicLink())
            this.onChange(uri, vscodelc.FileChangeType.Changed);
        } catch {
          // Already gone again.
        }
        return;
      }
      const key = uri.toString();
      const current = await identity(uri);
      const previous = identities.get(key);
      if (current)
        identities.set(key, current);
      else
        identities.delete(key);
      if (current && previous && current !== previous)
        this.onChange(uri, vscodelc.FileChangeType.Changed);
    });
    return watcher;
  }

  private createWatchers() {
    this.watchers.forEach(watcher => watcher.dispose());
    // Folders of a multi-root workspace can have their own associations. The
    // watchers apply to all folders, which at worst watches a few extra files.
    const folders = vscode.workspace.workspaceFolders ?? [];
    const associations = [
      contributedAssociations(),
      ...[undefined, ...folders].map(
          folder => vscode.workspace.getConfiguration('files', folder)
                        .get<Associations>('associations'))
    ];
    this.files = watchedFiles(associations);
    // Globs given as strings only match files in the workspace folders.
    const extensions = this.serverWatches
                           ? this.files.extensions.filter(
                                 e => !serverWatchedExtensions.has(e))
                           : this.files.extensions;
    const patterns = this.files.patterns.map(
        pattern =>
            anyCase(pattern.includes('/') ? pattern : `**/${pattern}`));
    if (extensions.length)
      patterns.unshift(`**/${extensionsGlob(extensions)}`);
    this.watchers = patterns.map(pattern => this.watch(pattern));
    // Deleting or moving in a directory can be reported as a single event for
    // the directory, which the patterns above don't match.
    this.watchers.push(this.watchDirectories('**'));

    this.disposeDirectoryWatchers();
    this.updateDirectoryWatchers();
  }

  // Watches the directories of open files outside the workspace folders, which
  // neither the watchers above nor clangd's watch, for the files in them that
  // are associated with clangd's languages: by their extensions or names, or
  // by their paths, such as the standard header vector by
  // **/include/c++/**, which VS Code applies outside the workspace folders
  // too. Open files that are only known to be in clangd's languages, such as a
  // header detected from its first line, or whose language was selected, are
  // watched themselves in the workspace folders.
  private updateDirectoryWatchers() {
    // Extensions can have several parts, such as h.in
    const extensions = this.files.extensions.map(extension => `.${extension}`);
    const names = this.files.patterns.filter(pattern => !pattern.includes('/'))
                      .map(globToRegExp);
    const paths = this.files.patterns.filter(pattern => pattern.includes('/'))
                      .map(globToRegExp);
    const isAssociatedByName = (uri: vscode.Uri) => {
      const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
      const lowerName = name.toLowerCase();
      // Patterns match native paths with either separator, like C:/sdk/**
      const fsPath = uri.fsPath.replace(/\\/g, '/');
      return extensions.some(extension => lowerName.length > extension.length &&
                                          lowerName.endsWith(extension)) ||
             names.some(pattern => pattern.test(name)) ||
             paths.some(pattern => pattern.test(uri.path) ||
                                   pattern.test(fsPath));
    };
    const isOpen = (uri: vscode.Uri) => vscode.workspace.textDocuments.some(
        document => document.uri.toString() === uri.toString() &&
                    isClangdDocument(document));
    const isAssociated = (uri: vscode.Uri) =>
        isAssociatedByName(uri) || isOpen(uri);

    const directories = new Map<string, vscode.Uri>();
    const documents = new Map<string, vscode.Uri>();
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme !== 'file' || !isClangdDocument(document))
        continue;
      if (!vscode.workspace.getWorkspaceFolder(document.uri)) {
        const directory = vscode.Uri.joinPath(document.uri, '..');
        directories.set(`directory ${directory}`, directory);
      } else if (!isAssociatedByName(document.uri)) {
        documents.set(`document ${document.uri}`, document.uri);
      }
    }
    for (const [key, watchers] of this.directoryWatchers) {
      if (!directories.has(key) && !documents.has(key)) {
        watchers.forEach(watcher => watcher.dispose());
        this.directoryWatchers.delete(key);
      }
    }
    // Returns a pattern matching a name in a directory, and a filter of the
    // events of the other names that it matches
    const namePattern = (uri: vscode.Uri) => {
      const directory = vscode.Uri.joinPath(uri, '..');
      const name = uri.path.slice(uri.path.lastIndexOf('/') + 1);
      const pattern = new vscode.RelativePattern(
          directory, name.replace(/[[\]{}*?!,]/g, '?'));
      const filter = (event: vscode.Uri) =>
          event.path.slice(event.path.lastIndexOf('/') + 1).toLowerCase() ===
          name.toLowerCase();
      return {directory, name, pattern, filter};
    };
    for (const [key, document] of documents) {
      if (!this.directoryWatchers.has(key)) {
        const {pattern, filter} = namePattern(document);
        this.directoryWatchers.set(key, [this.watch(pattern, filter)]);
      }
    }
    for (const [key, directory] of directories) {
      if (this.directoryWatchers.has(key))
        continue;
      const watchers = [
        this.watch(new vscode.RelativePattern(directory, '*'), isAssociated),
        this.watchDirectories(new vscode.RelativePattern(directory, '*'),
                              undefined, /*replacements=*/ true)
      ];
      // The directory itself, which its parent's watcher reports
      const {directory: parent, name, pattern, filter} = namePattern(directory);
      if (parent.path !== directory.path && name)
        watchers.push(
            this.watchDirectories(pattern, filter, /*replacements=*/ true));
      this.directoryWatchers.set(key, watchers);
    }
  }

  private disposeDirectoryWatchers() {
    for (const watchers of this.directoryWatchers.values())
      watchers.forEach(watcher => watcher.dispose());
    this.directoryWatchers.clear();
  }

  // Saves from VS Code are reported too. Those already sent a didSave, but
  // telling them apart from external changes isn't reliable, and an extra
  // reparse of files whose dependencies are unchanged is cheap.
  private onChange(uri: vscode.Uri, type: vscodelc.FileChangeType) {
    this.changed.set(uri.toString(), {uri, type});
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), debounceMs);
  }

  private async flush() {
    this.timer = undefined;
    // Changes that arrive while we wait for reloads are picked up by the next
    // flush, which the change handler schedules.
    if (this.running)
      return this.schedule();
    this.running = true;
    try {
      const changes = [...this.changed.values()];
      this.changed.clear();
      await Promise.all(changes.map(change => this.waitForReload(change.uri)));
      if (!this.disposed)
        this.notifyServer(changes);
    } finally {
      this.running = false;
    }
  }

  private schedule() {
    if (this.timer === undefined)
      this.timer = setTimeout(() => this.flush(), debounceMs);
  }

  // If `uri` is open and unmodified, VS Code reloads it from disk. Wait until
  // that has happened, so clangd never combines the new contents of one file
  // with the old contents of another.
  private async waitForReload(uri: vscode.Uri) {
    const key = uri.toString();
    const document = () => vscode.workspace.textDocuments.find(
        d => d.uri.toString() === key && isClangdDocument(d) && !d.isDirty);
    if (!document())
      return;
    const deadline = Date.now() + reloadTimeoutMs;
    while (!this.disposed && Date.now() < deadline) {
      const current = document();
      if (!current || await this.matchesDisk(current))
        return;
      await new Promise<void>(resolve => {
        const timeout = setTimeout(done, deadline - Date.now());
        const listener = vscode.workspace.onDidChangeTextDocument(e => {
          if (e.document.uri.toString() === key)
            done();
        });
        function done() {
          clearTimeout(timeout);
          listener.dispose();
          resolve();
        }
      });
    }
  }

  private async matchesDisk(document: vscode.TextDocument): Promise<boolean> {
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(document.uri);
    } catch {
      // Deleted or unreadable: VS Code won't reload it, so don't wait.
      return true;
    }
    // VS Code may have decoded the file differently, e.g. as Windows-1252.
    // Then the contents can't be compared, so don't wait.
    let text: string;
    try {
      text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    } catch {
      return true;
    }
    return text === document.getText();
  }

  // A clangd that watches files itself is told which files changed, which
  // rebuilds the ASTs of the open files, also for files they include after
  // their preambles. Other clangd versions only reparse open files on a
  // didSave, which keeps the ASTs whose preambles and contents are unchanged.
  private notifyServer(
      changes: {uri: vscode.Uri; type: vscodelc.FileChangeType}[]) {
    const client = this.context.client;
    if (client.state !== vscodelc.State.Running)
      return;
    if (this.serverWatches) {
      client.sendNotification(
          vscodelc.DidChangeWatchedFilesNotification.type, {
            changes: changes.map(
                change => ({
                  uri: client.code2ProtocolConverter.asUri(change.uri),
                  type: change.type
                }))
          });
      return;
    }
    // clangd reparses every open file on any didSave, so one is enough.
    const document = vscode.workspace.textDocuments.find(isClangdDocument);
    if (!document)
      return;
    client.sendNotification(vscodelc.DidSaveTextDocumentNotification.type, {
      textDocument: {uri: client.code2ProtocolConverter.asUri(document.uri)}
    });
  }
}
