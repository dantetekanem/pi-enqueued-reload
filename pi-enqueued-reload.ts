import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function piEnqueuedReload(pi: ExtensionAPI) {
  let pending = false;
  let disposed = false;

  pi.on("session_shutdown", () => {
    disposed = true;
  });

  pi.registerCommand("pi-enqueued-reload", {
    description: "Reload after Pi finishes its work",
    handler: async (_args, ctx) => {
      if (disposed || pending) return;
      pending = true;
      try {
        if (!ctx.isIdle()) {
          ctx.ui.notify("Pi will reload when it finishes its work.", "info");
        }
        while (!disposed && !ctx.isIdle()) {
          await ctx.waitForIdle();
        }
        if (disposed) return;
        await ctx.reload();
        return;
      } catch (error) {
        if (!disposed) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`Reload failed: ${message}`, "error");
        }
      } finally {
        pending = false;
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    let createEditor = ctx.ui.getEditorComponent();
    if (!createEditor) {
      const { CustomEditor } = await import("@earendil-works/pi-coding-agent");
      createEditor = (tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings);
    }
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = createEditor(tui, theme, keybindings);
      const handleInput = editor.handleInput?.bind(editor);
      editor.handleInput = (data) => {
        // Pi assigns onSubmit after the factory returns. Intercept only while
        // this editor handles input, not Enter in dialogs or other components.
        const submit = editor.onSubmit;
        editor.onSubmit = (text) => {
          const command = text.trim() === "/reload" ? "/pi-enqueued-reload" : text;
          submit?.call(editor, command);
        };
        try {
          handleInput?.(data);
        } finally {
          editor.onSubmit = submit;
        }
      };
      return editor;
    });
  });
}
