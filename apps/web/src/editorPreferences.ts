import {
  buildRemoteOpenUrl,
  buildWslOpenUrl,
  EDITORS,
  EditorId,
  EnvironmentId,
  WSL_CAPABLE_EDITOR_IDS,
} from "@t3tools/contracts";
import {
  mapAtomCommandResult,
  type AtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { useLocalStorage } from "./hooks/useLocalStorage";
import { useCallback, useMemo } from "react";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { openRemoteEditorUrl, useRemoteCapableEditors, useRemoteOpenState } from "./remoteOpen";

const LAST_EDITOR_KEY = "t3code:last-editor";

export class PreferredEditorEnvironmentRequiredError extends Schema.TaggedError<PreferredEditorEnvironmentRequiredError>()(
  "PreferredEditorEnvironmentRequiredError",
  {
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot open ${this.targetPath} because no environment is selected.`;
  }
}

export class PreferredEditorUnavailableError extends Schema.TaggedError<PreferredEditorUnavailableError>()(
  "PreferredEditorUnavailableError",
  {
    environmentId: EnvironmentId,
    targetPath: Schema.String,
    availableEditorIds: Schema.Array(EditorId),
  },
) {
  override get message(): string {
    return `No available editor can open ${this.targetPath} in environment ${this.environmentId}.`;
  }
}

export class PreferredEditorLaunchError extends Schema.TaggedError<PreferredEditorLaunchError>()(
  "PreferredEditorLaunchError",
  { editor: EditorId, targetPath: Schema.String },
) {
  override get message(): string {
    return `Could not open ${this.targetPath} in ${this.editor}.`;
  }
}

export function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [lastEditor, setLastEditor] = useLocalStorage(LAST_EDITOR_KEY, null, EditorId);

  const effectiveEditor = useMemo(() => {
    if (lastEditor && availableEditors.includes(lastEditor)) return lastEditor;
    return EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null;
  }, [lastEditor, availableEditors]);

  return [effectiveEditor, setLastEditor] as const;
}

/** Editor selection and launch routing shared by pickers, file actions, and shortcuts. */
export function useEditorOpening(
  environmentId: EnvironmentId | null,
  availableEditors: readonly EditorId[],
) {
  const remote = useRemoteOpenState(environmentId);
  const remoteCapableEditors = useRemoteCapableEditors();
  const effectiveEditors = useMemo(() => {
    if (remote.mode === "local-exec") return availableEditors;
    if (remote.mode === "remote-unavailable") return [];
    return remote.host.kind === "wsl"
      ? remoteCapableEditors.filter((editor) => WSL_CAPABLE_EDITOR_IDS.includes(editor))
      : remoteCapableEditors;
  }, [availableEditors, remote, remoteCapableEditors]);
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(effectiveEditors);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  type OpenInEditorError = AtomCommandFailure<Awaited<ReturnType<typeof openInEditor>>>;

  const openEditor = useCallback(
    async (
      targetPath: string,
      requestedEditor?: EditorId,
      targetKind: "file" | "directory" = "directory",
    ): Promise<
      AtomCommandResult<
        EditorId,
        | OpenInEditorError
        | PreferredEditorEnvironmentRequiredError
        | PreferredEditorUnavailableError
        | PreferredEditorLaunchError
      >
    > => {
      if (environmentId === null) {
        return AsyncResult.failure(
          Cause.fail(
            new PreferredEditorEnvironmentRequiredError({
              targetPath,
            }),
          ),
        );
      }
      const editor = requestedEditor ?? preferredEditor;
      if (!editor || !effectiveEditors.includes(editor)) {
        return AsyncResult.failure(
          Cause.fail(
            new PreferredEditorUnavailableError({
              environmentId,
              targetPath,
              availableEditorIds: effectiveEditors,
            }),
          ),
        );
      }
      if (remote.mode === "remote-links") {
        const url =
          remote.host.kind === "wsl"
            ? buildWslOpenUrl({
                editor,
                distro: remote.host.host,
                absolutePath: targetPath,
                isFile: targetKind === "file",
              })
            : buildRemoteOpenUrl({ editor, host: remote.host.host, absolutePath: targetPath });
        if (url === undefined || !(await openRemoteEditorUrl(url))) {
          return AsyncResult.failure(
            Cause.fail(new PreferredEditorLaunchError({ editor, targetPath })),
          );
        }
        setPreferredEditor(editor);
        return AsyncResult.success(editor);
      }
      const result = await openInEditor({
        environmentId,
        input: {
          cwd: targetPath,
          editor,
        },
      });
      if (result._tag === "Success") setPreferredEditor(editor);
      return mapAtomCommandResult(result, () => editor);
    },
    [effectiveEditors, environmentId, openInEditor, preferredEditor, remote, setPreferredEditor],
  );

  return { remote, availableEditors: effectiveEditors, preferredEditor, openEditor };
}

export function useOpenInPreferredEditor(
  environmentId: EnvironmentId | null,
  availableEditors: readonly EditorId[],
) {
  const { openEditor } = useEditorOpening(environmentId, availableEditors);
  return useCallback(
    (targetPath: string) => openEditor(targetPath, undefined, "file"),
    [openEditor],
  );
}
