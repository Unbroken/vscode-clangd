// Automatically install the Malterlib LLVM distribution of clangd.
//
// Unlike upstream vscode-clangd, which downloads prebuilt release archives from
// github.com/clangd/clangd, this clones the platform/architecture-specific
// Malterlib LLVM binary repository and uses the clangd shipped inside it. Those
// repositories store their contents in Git LFS, so cloning requires `git` and
// `git-lfs` on the PATH (mirroring how `mib` bootstraps the same binaries).
//
// There are several entry points:
//  - installation explicitly requested (`clangd.install`)
//  - checking for updates, manual (`clangd.update`) or automatic
//  - no usable clangd found, try to recover
// These have different flows, but the same underlying mechanisms.

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import * as config from './config';

// Returns the clangd path to be used, or null if clangd is not installed.
export async function activate(disposables: vscode.Disposable[],
                               globalStoragePath: string):
    Promise<string|null> {
  const ui = await UI.create(disposables, globalStoragePath);
  disposables.push(vscode.commands.registerCommand(
      'clangd.install', async () => Installer.installLatest(ui)));
  disposables.push(vscode.commands.registerCommand(
      'clangd.update', async () => Installer.checkUpdates(true, ui)));
  const status =
      await Installer.prepare(ui, await config.get<boolean>('checkUpdates'));
  return status.clangdPath;
}

class UI {
  static async create(disposables: vscode.Disposable[],
                      globalStoragePath: string): Promise<UI> {
    const ui = new UI(disposables, globalStoragePath);
    await ui.resolveClangdPath();
    return ui;
  }

  private constructor(private disposables: vscode.Disposable[],
                      private globalStoragePath: string) {}

  get storagePath(): string { return this.globalStoragePath; }
  async choose(prompt: string, options: string[]): Promise<string|undefined> {
    return await vscode.window.showInformationMessage(prompt, ...options);
  }
  slow<T>(title: string, result: Promise<T>) {
    const opts = {
      location: vscode.ProgressLocation.Notification,
      title: title,
      cancellable: false,
    };
    return Promise.resolve(vscode.window.withProgress(opts, () => result));
  }
  progress<T>(title: string, cancel: AbortController|null,
              body: (progress: (fraction: number) => void) => Promise<T>) {
    const opts = {
      location: vscode.ProgressLocation.Notification,
      title: title,
      cancellable: cancel !== null,
    };
    const result = vscode.window.withProgress(opts, async (progress, canc) => {
      if (cancel)
        canc.onCancellationRequested((_) => cancel.abort());
      let lastFraction = 0;
      return body(fraction => {
        if (fraction > lastFraction) {
          progress.report({increment: 100 * (fraction - lastFraction)});
          lastFraction = fraction;
        }
      });
    });
    return Promise.resolve(result); // Thenable to real promise.
  }
  localize(message: string, ...args: Array<string|number|boolean>): string {
    let ret = message;
    for (const i in args) {
      ret = ret.replace(`{${i}}`, args[i].toString());
    }
    return ret;
  }
  error(s: string) { vscode.window.showErrorMessage(s); }
  info(s: string) { vscode.window.showInformationMessage(s); }
  command(name: string, body: () => any) {
    this.disposables.push(vscode.commands.registerCommand(name, body));
  }

  async shouldReuse(release: string): Promise<boolean|undefined> {
    const message = `clangd ${release} is already installed!`;
    const use = 'Use the installed version';
    const reinstall = 'Delete it and reinstall';
    const response =
        await vscode.window.showInformationMessage(message, use, reinstall);
    if (response === use) {
      // Reuse the existing installation.
      return true;
    } else if (response === reinstall) {
      // Remove the existing installation.
      return false;
    } else {
      // User dismissed prompt, bail out.
      return undefined;
    }
  }

  private _pathUpdated: Promise<void>|null = null;

  async promptReload(message: string) {
    vscode.window.showInformationMessage(message);
    await this._pathUpdated;
    this._pathUpdated = null;
    vscode.commands.executeCommand('clangd.restart');
  }

  async showHelp(message: string, url: string) {
    if (await vscode.window.showInformationMessage(message, 'Open website'))
      vscode.env.openExternal(vscode.Uri.parse(url));
  }

  async promptUpdate(current: string) {
    const message =
        'An updated Malterlib clangd language server build is available.\n ' +
        `Would you like to update? (currently ${current})`;
    const update = 'Update';
    const dontCheck = 'Don\'t ask again';
    const response =
        await vscode.window.showInformationMessage(message, update, dontCheck);
    if (response === update) {
      Installer.update(this);
    } else if (response === dontCheck) {
      config.update('checkUpdates', false, vscode.ConfigurationTarget.Global);
    }
  }

  async promptInstall() {
    const message =
        'The Malterlib clangd language server isn\'t installed yet.\n' +
        'Would you like to download and install it?';
    const install = 'Install';
    const dontAsk = 'Don\'t ask again';
    const response =
        await vscode.window.showInformationMessage(message, install, dontAsk);
    if (response === install) {
      Installer.installLatest(this);
    } else if (response === dontAsk) {
      await config.update('suggestMalterlibInstall', false,
                          vscode.ConfigurationTarget.Global);
      // Suggestions are now off: re-run activation so a system clangd (if any)
      // is used from here on.
      vscode.commands.executeCommand('clangd.restart');
    }
  }

  // Whether clangd.path has been explicitly set (in any scope), as opposed to
  // falling back to its default value.
  clangdPathIsUserSet(): boolean {
    const inspect =
        vscode.workspace.getConfiguration('clangd').inspect<string>('path');
    return inspect !== undefined &&
           (inspect.globalValue !== undefined ||
            inspect.workspaceValue !== undefined ||
            inspect.workspaceFolderValue !== undefined);
  }

  async resolveClangdPath() {
    let p = await config.get<string>('path');
    // Backwards compatibility: if it's a relative path with a slash, interpret
    // relative to project root.
    if (!path.isAbsolute(p) && p.includes(path.sep) &&
        vscode.workspace.rootPath !== undefined) {
      p = path.join(vscode.workspace.rootPath, p);
    }

    this._clangdPath = p;
  }

  private _clangdPath?: string = undefined;

  get clangdPath(): string { return this._clangdPath as string; }
  set clangdPath(p: string) {
    this._pathUpdated = new Promise(resolve => {
      config.update('path', p, vscode.ConfigurationTarget.Global).then(() => {
        this._clangdPath = p;
        resolve();
      });
    });
  }
}

// The Malterlib getting-started page, offered when installation isn't possible.
const installURL = 'https://github.com/Malterlib/Malterlib';

// Malterlib bootstrap + custom Git LFS transfer agent.
//
// The Malterlib LLVM repositories don't serve their (large) binaries through
// GitHub's LFS endpoint. They use a custom "release store" transfer agent
// implemented by the Malterlib tool (MTool, invoked as `mib`). We reuse an
// existing MTool install when the user has one, otherwise bootstrap it exactly
// like the `mib` script does before pulling.
const MALTERLIB_REPO_ROOT = 'https://github.com/Malterlib';
const LFS_TRANSFER_AGENT = 'malterlib-release';
// Must match `BootstrapVersion` in the Malterlib `mib` script; bump when it does.
const MALTERLIB_BOOTSTRAP_VERSION = '5';
const MALTERLIB_HOME = path.join(os.homedir(), '.Malterlib');

// Downloads, installs and updates the Malterlib LLVM distribution of clangd.
namespace Installer {
  // Main startup workflow: check whether the configured clangd binary is usable.
  // If not, offer to install one. If so, optionally check for updates.
  export async function prepare(ui: UI, checkUpdate: boolean):
      Promise<{clangdPath: string|null}> {
    const configured = ui.clangdPath;
    // Resolve the configured clangd (may be a system clangd found on PATH).
    let resolved: string|null;
    if (path.isAbsolute(configured))
      resolved = await fileExists(configured) ? configured : null;
    else
      resolved = await onPath(configured);

    if (ui.clangdPathIsUserSet()) {
      // Respect an explicit clangd.path (e.g. a Malterlib workspace checkout).
      if (resolved === null)
        recover(ui);
      else if (checkUpdate && await installExists(ui))
        checkUpdates(/*requested=*/ false, ui);
      return {clangdPath: resolved};
    }

    // clangd.path is unset: prefer the Malterlib distribution over whatever
    // clangd happens to be on PATH.
    const managed = clangdBinaryPath(installPath(ui));
    if (await fileExists(managed)) {
      if (checkUpdate)
        checkUpdates(/*requested=*/ false, ui);
      return {clangdPath: managed};
    }

    // Not installed yet. If we're going to offer the Malterlib install, hold off
    // on starting a system clangd first: that would background-index and pollute
    // the clangd cache before the user has decided. Return no clangd until they
    // answer — "Install" restarts into the Malterlib clangd; "Don't ask again"
    // restarts and falls back to the system clangd (see promptInstall).
    if (await config.get<boolean>('suggestMalterlibInstall')) {
      recover(ui);
      return {clangdPath: null};
    }

    // Suggestions disabled: use a system clangd if present, else offer install.
    if (resolved === null)
      recover(ui);
    return {clangdPath: resolved};
  }

  // The user has explicitly asked to install clangd, or accepted a prompt to.
  // Clone the Malterlib LLVM distribution, or report an error.
  export async function installLatest(ui: UI) {
    const abort = new AbortController();
    try {
      const t = target(); // Throws if this host is unsupported.
      const installDir = installPath(ui);
      const clangdPath = clangdBinaryPath(installDir);
      if (await fileExists(clangdPath)) {
        const version = await clangdVersion(clangdPath);
        const reuse = await ui.shouldReuse(version ?? 'from the Malterlib LLVM distribution');
        if (reuse === undefined) {
          // User dismissed prompt, bail out.
          abort.abort();
          return;
        }
        if (!reuse) {
          await fs.promises.rm(installDir, {recursive: true, force: true});
          await clone(t, installDir, abort, ui);
        }
      } else {
        await clone(t, installDir, abort, ui);
      }
      ui.clangdPath = clangdPath;
      const version = await clangdVersion(clangdPath);
      ui.promptReload(
          ui.localize('clangd {0} is now installed.', version ?? ''));
    } catch (e) {
      if (!abort.signal.aborted) {
        console.error('Failed to install clangd: ', e);
        const message = ui.localize(
            'Failed to install the Malterlib clangd language server: {0}\nYou may want to install it manually.',
            `${e}`);
        ui.showHelp(message, installURL);
      }
    }
  }

  // Pull the newest build into the existing Malterlib LLVM clone.
  export async function update(ui: UI) {
    const abort = new AbortController();
    try {
      const t = target(); // Throws if this host is unsupported.
      const installDir = installPath(ui);
      const clangdPath = clangdBinaryPath(installDir);
      await ensureTools();
      const mib = await ensureMTool(t, abort, ui);
      // Fetch/reset with the smudge filter suppressed so the (large) binaries
      // aren't downloaded inline during checkout; `git lfs pull` fetches them
      // through the release-store transfer agent.
      await ui.progress(
          ui.localize('Updating clangd (Malterlib LLVM)…'), abort,
          async () => {
            await run('git', ['fetch', '--depth', '1', 'origin', 'HEAD'],
                      {cwd: installDir, env: skipSmudgeEnv, signal: abort.signal});
            await run('git', ['reset', '--hard', 'FETCH_HEAD'],
                      {cwd: installDir, env: skipSmudgeEnv, signal: abort.signal});
            await configureLfsAgent(installDir, t.repoUrl, mib, abort);
            await run('git', ['lfs', 'pull'],
                      {cwd: installDir, signal: abort.signal});
          });
      ui.clangdPath = clangdPath;
      const version = await clangdVersion(clangdPath);
      ui.promptReload(
          ui.localize('clangd {0} is now installed.', version ?? ''));
    } catch (e) {
      if (!abort.signal.aborted) {
        console.error('Failed to update clangd: ', e);
        const message = ui.localize(
            'Failed to update the Malterlib clangd language server: {0}',
            `${e}`);
        ui.showHelp(message, installURL);
      }
    }
  }

  // We have an installed Malterlib clangd; check whether the upstream repository
  // has a newer commit and offer to update if so.
  export async function checkUpdates(requested: boolean, ui: UI) {
    const installDir = installPath(ui);
    const clangdPath = clangdBinaryPath(installDir);
    if (!await fileExists(clangdPath)) {
      // Not a Malterlib-managed install: we have nothing to update.
      if (requested)
        ui.info(ui.localize(
            'clangd was not installed by this extension; automatic updates are unavailable.'));
      return;
    }
    let localSha: string;
    let remoteSha: string;
    try {
      target(); // Throws if this host is unsupported.
      await ensureTools();
      localSha =
          (await run('git', ['rev-parse', 'HEAD'], {cwd: installDir})).stdout.trim();
      const lsRemote =
          (await run('git', ['ls-remote', 'origin', 'HEAD'], {cwd: installDir}))
              .stdout.trim();
      remoteSha = lsRemote.split(/\s+/, 1)[0];
    } catch (e) {
      console.error('Failed to check for clangd update: ', e);
      // We're not sure whether there's an upgrade: stay quiet unless asked.
      if (requested)
        ui.error(ui.localize('Failed to check for clangd update: {0}', `${e}`));
      return;
    }
    console.info('Checking for clangd update: local=', localSha, ' remote=',
                 remoteSha);
    if (!remoteSha || remoteSha === localSha) {
      if (requested)
        ui.info(ui.localize('clangd is up-to-date.'));
      return;
    }
    const current = await clangdVersion(clangdPath) ?? localSha.slice(0, 7);
    ui.promptUpdate(current);
  }

  // The extension has detected clangd isn't available.
  // Inform the user, and if possible offer to install.
  async function recover(ui: UI) {
    try {
      target(); // Throws if this host is unsupported.
      ui.promptInstall();
    } catch (e) {
      console.error('Auto-install failed: ', e);
      ui.showHelp(
          ui.localize('The clangd language server is not installed.'),
          installURL);
    }
  }

  // Clone the Malterlib LLVM distribution into `installDir`.
  //
  // The binaries are served by MTool's custom "release store" LFS transfer
  // agent, not GitHub LFS. So we bootstrap/locate MTool, clone with the smudge
  // filter suppressed, point the clone's Git LFS config at the
  // `malterlib-release` agent, then `git lfs pull` fetches through it. git-lfs
  // emits no machine-readable progress without a TTY, so the notification is
  // indeterminate (but cancellable).
  async function clone(t: Target, installDir: string, abort: AbortController,
                       ui: UI) {
    await ensureTools();
    const mib = await ensureMTool(t, abort, ui);
    await fs.promises.mkdir(path.dirname(installDir), {recursive: true});
    try {
      await ui.progress(
          ui.localize('Downloading clangd (Malterlib LLVM)…'), abort,
          async () => {
            await run('git', ['clone', '--depth', '1', t.repoUrl, installDir],
                      {env: skipSmudgeEnv, signal: abort.signal});
            await run('git', ['lfs', 'install', '--local'],
                      {cwd: installDir, signal: abort.signal});
            await configureLfsAgent(installDir, t.repoUrl, mib, abort);
            await run('git', ['lfs', 'pull'],
                      {cwd: installDir, signal: abort.signal});
          });
    } catch (e) {
      // Don't leave a half-cloned directory behind on failure or cancellation.
      await fs.promises.rm(installDir, {recursive: true, force: true})
          .catch(() => {});
      throw e;
    }
  }

  // Point a clone's Git LFS configuration at the Malterlib release-store
  // transfer agent, and exclude the large `lfs` ref namespace from fetches.
  // Mirrors the setup the `mib` tool performs on these repositories.
  async function configureLfsAgent(installDir: string, repoUrl: string,
                                   mib: string, abort: AbortController) {
    const set = (key: string, value: string) =>
        run('git', ['config', key, value],
            {cwd: installDir, signal: abort.signal});
    await set(`lfs.customtransfer.${LFS_TRANSFER_AGENT}.path`, mib);
    await set(`lfs.customtransfer.${LFS_TRANSFER_AGENT}.args`,
              'lfs-release-store');
    await set(`lfs.customtransfer.${LFS_TRANSFER_AGENT}.concurrent`, 'true');
    // Keyed by the exact remote URL (git splits on the first and last dot).
    await set(`lfs.${repoUrl}.standalonetransferagent`, LFS_TRANSFER_AGENT);
    await set('remote.origin.malterlib-lfs-setup', 'true');
    await run('git',
              ['config', '--add', 'remote.origin.fetch', '^refs/heads/lfs'],
              {cwd: installDir, signal: abort.signal});
    await run('git',
              ['config', '--add', 'remote.origin.fetch', '^refs/tags/lfs/*'],
              {cwd: installDir, signal: abort.signal});
  }

  // Locate an existing MTool (`mib`) install, or bootstrap one the same way the
  // `mib` script does: download the platform's MTool release, extract it under
  // ~/.Malterlib/bootstrap/<version>, and run `install-binaries`. Returns the
  // path to the MTool executable to use as the LFS transfer agent.
  async function ensureMTool(t: Target, abort: AbortController,
                             ui: UI): Promise<string> {
    const binDir = path.join(MALTERLIB_HOME, 'bin');
    const existing = await findMib(binDir);
    if (existing)
      return existing;

    const bootstrapDir =
        path.join(MALTERLIB_HOME, 'bootstrap', MALTERLIB_BOOTSTRAP_VERSION);
    await ui.progress(
        ui.localize('Downloading the Malterlib tools…'), abort, async () => {
          if (await fileExists(path.join(bootstrapDir, 'Bootstrap.version')))
            return; // Already extracted by a previous run.
          await requireTool(
              'curl', ['--version'],
              'curl was not found on your PATH. It is required to download the Malterlib tools.');
          await requireTool(
              'tar', ['--version'],
              'tar was not found on your PATH. It is required to unpack the Malterlib tools.');
          const archive = path.join(
              os.tmpdir(), `MalterlibMTool-${MALTERLIB_BOOTSTRAP_VERSION}-${
                               t.platform}-${t.arch}.tar.gz`);
          await run('curl',
                    ['-fL', '--no-progress-meter', '-o', archive,
                     mtoolAssetUrl(t.platform, t.arch)],
                    {signal: abort.signal});
          await fs.promises.mkdir(bootstrapDir, {recursive: true});
          // --force-local on Windows so drive-letter colons aren't treated as
          // a remote host, matching the `mib` script.
          const tarArgs = process.platform === 'win32'
                              ? ['--force-local', '-xf', archive]
                              : ['-xf', archive];
          await run('tar', tarArgs, {cwd: bootstrapDir, signal: abort.signal});
          await fs.promises.rm(archive, {force: true}).catch(() => {});
          // Populate ~/.Malterlib/bin (best effort; the extracted tool already
          // works as the transfer agent regardless).
          const extracted = await findMib(bootstrapDir);
          if (extracted)
            await run(extracted, ['install-binaries'],
                      {cwd: bootstrapDir, signal: abort.signal})
                .catch(() => {});
        });

    const mib = await findMib(binDir) ?? await findMib(bootstrapDir);
    if (!mib)
      throw new Error(
          'Failed to bootstrap the Malterlib tools (MTool); the Malterlib LLVM distribution cannot be downloaded.');
    return mib;
  }

  // Find the MTool (`mib`) executable within a Malterlib bin directory. The
  // names match the MTool.tar.gz release package contents (see ReleasePackage
  // in Malterlib_Core_RepositoryBinary.MHeader): `mib`/`MTool` on macOS & Linux,
  // `mib.exe`/`MTool.exe` on Windows.
  async function findMib(dir: string): Promise<string|null> {
    const names = process.platform === 'win32' ? ['mib.exe', 'MTool.exe']
                                               : ['mib', 'MTool'];
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await fileExists(candidate))
        return candidate;
    }
    return null;
  }

  // Whether a Malterlib-managed clangd already exists on disk.
  async function installExists(ui: UI): Promise<boolean> {
    return fileExists(clangdBinaryPath(installPath(ui)));
  }

  // Verify that git and git-lfs are available, matching how `mib` bootstraps.
  async function ensureTools() {
    await requireTool(
        'git', ['--version'],
        'Git was not found on your PATH. Please install Git to download the Malterlib LLVM distribution.');
    await requireTool(
        'git', ['lfs', 'version'],
        'Git LFS was not found. Please install Git LFS (https://git-lfs.com) to download the Malterlib LLVM distribution.');
  }
}

interface Target {
  platform: string;
  arch: string;
  repoUrl: string;
}

// Resolve the Malterlib LLVM binary repository for the current host, or throw if
// the platform/architecture combination isn't published.
function target(): Target {
  const platforms: {[k: string]: string} =
      {darwin: 'macOS', linux: 'Linux', win32: 'Windows'};
  const archs: {[k: string]: string} = {x64: 'x64', arm64: 'arm64', ia32: 'x86'};
  const supported: {[k: string]: string[]} = {
    macOS: ['x64', 'arm64'],
    Linux: ['x64', 'arm64', 'x86'],
    Windows: ['x64', 'arm64'],
  };
  const platform = platforms[os.platform()];
  const arch = archs[os.arch()];
  if (!platform || !arch || !supported[platform].includes(arch)) {
    throw new Error(`The Malterlib LLVM distribution has no clangd build for ${
        os.platform()}/${os.arch()}.`);
  }
  return {
    platform,
    arch,
    repoUrl: `${MALTERLIB_REPO_ROOT}/MalterlibLLVMBinaries_${platform}_${
        arch}_rLFS.git`,
  };
}

// URL of the MTool bootstrap archive for a platform/arch — the same release the
// `mib` script downloads to bootstrap the Malterlib tools.
function mtoolAssetUrl(platform: string, arch: string): string {
  return `${MALTERLIB_REPO_ROOT}/MalterlibBinaries_${platform}_${
      arch}_rLFS/releases/download/bootstrap%2F${
      MALTERLIB_BOOTSTRAP_VERSION}/MTool.tar.gz`;
}

// Directory the Malterlib LLVM distribution is cloned into.
function installPath(ui: UI): string {
  return path.join(ui.storagePath, 'malterlib-llvm');
}

// Path to the clangd executable within a Malterlib LLVM clone.
function clangdBinaryPath(installDir: string): string {
  const name = os.platform() === 'win32' ? 'clangd.exe' : 'clangd';
  return path.join(installDir, 'bin', name);
}

// Get the version of an installed clangd binary using `clangd --version`.
// e.g. "clangd version 22.1.8 (...)" -> "22.1.8".
async function clangdVersion(clangdPath: string): Promise<string|undefined> {
  try {
    const {stdout} = await run(clangdPath, ['--version']);
    const match = stdout.match(/clangd version (\S+)/);
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

// Locate an executable named `command` on the PATH, or null if not found.
async function onPath(command: string): Promise<string|null> {
  // A command containing a path separator is not a bare PATH lookup.
  if (command.includes(path.sep))
    return null;
  const exts = process.platform === 'win32'
                   ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
                         .split(';')
                         .filter(Boolean)
                   : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir)
      continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        await fs.promises.access(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Not here, keep looking.
      }
    }
  }
  return null;
}

// Environment that suppresses the Git LFS smudge filter, so checkouts write LFS
// pointer files instead of downloading binaries inline (we pull them explicitly).
const skipSmudgeEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_LFS_SKIP_SMUDGE: '1',
};

interface RunResult {
  stdout: string;
  stderr: string;
}

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

// Run a command, capturing stdout/stderr. Rejects on non-zero exit or if the
// process can't be spawned (e.g. the command is missing).
function run(command: string, args: string[],
             options: RunOptions = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = child_process.spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve({stdout, stderr});
      } else {
        reject(new Error(`'${command} ${args.join(' ')}' failed with exit code ${
            code}:\n${stderr.trim() || stdout.trim()}`));
      }
    });
  });
}

// Fail with a friendly message if a required external tool isn't runnable.
async function requireTool(command: string, args: string[], missing: string) {
  try {
    await run(command, args);
  } catch {
    throw new Error(missing);
  }
}
