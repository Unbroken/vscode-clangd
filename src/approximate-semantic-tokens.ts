import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient/node';

// clangd marks the semantic tokens of a header it parsed before the preamble of
// the file that includes it was built as approximate, a clangd extension of the
// semantic tokens results. Unbroken Code merges approximate tokens below more
// accurate ones, such as those of the Malterlib extension, and other editors
// ignore the property. The client's conversion of the results drops the
// extension, so the middleware sends the requests like the client does and
// copies it.

declare module 'vscode' {
  interface SemanticTokens {
    approximate?: boolean;
  }
  interface SemanticTokensEdits {
    approximate?: boolean;
  }
}

// The extension of a semantic tokens result
interface ApproximateResult {
  approximate?: boolean;
}

function
copyApproximate<T extends vscode.SemanticTokens|vscode.SemanticTokensEdits>(
    converted: T|undefined, result: object|null): T|undefined {
  if (converted && (result as ApproximateResult | null)?.approximate === true)
    converted.approximate = true;
  return converted;
}

export function middleware(getClient: () => vscodelc.BaseLanguageClient):
    vscodelc.Middleware {
  return {
    provideDocumentSemanticTokens: async (document, token) => {
      const client = getClient();
      const params: vscodelc.SemanticTokensParams = {
        textDocument:
            client.code2ProtocolConverter.asTextDocumentIdentifier(document)
      };
      try {
        const result = await client.sendRequest(
            vscodelc.SemanticTokensRequest.type, params, token);
        if (token.isCancellationRequested)
          return null;
        return copyApproximate(
            await client.protocol2CodeConverter.asSemanticTokens(result, token),
            result);
      } catch (error) {
        return client.handleFailedRequest(vscodelc.SemanticTokensRequest.type,
                                          token, error, null);
      }
    },
    provideDocumentSemanticTokensEdits: async (document, previousResultId,
                                               token) => {
      const client = getClient();
      const params: vscodelc.SemanticTokensDeltaParams = {
        textDocument:
            client.code2ProtocolConverter.asTextDocumentIdentifier(document),
        previousResultId
      };
      try {
        const result = await client.sendRequest(
            vscodelc.SemanticTokensDeltaRequest.type, params, token);
        if (token.isCancellationRequested)
          return null;
        if (vscodelc.SemanticTokens.is(result))
          return copyApproximate(
              await client.protocol2CodeConverter.asSemanticTokens(result,
                                                                   token),
              result);
        return copyApproximate(
            await client.protocol2CodeConverter.asSemanticTokensEdits(result,
                                                                      token),
            result);
      } catch (error) {
        return client.handleFailedRequest(
            vscodelc.SemanticTokensDeltaRequest.type, token, error, null);
      }
    },
  };
}
