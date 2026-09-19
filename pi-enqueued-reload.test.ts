import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piEnqueuedReload from "./pi-enqueued-reload.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const events = new Map<string, Function>();
  const commands = new Map<string, { handler: Function }>();
  const notices: string[] = [];
  const gate = deferred();
  let idle = true;
  let reloads = 0;
  let waits = 0;
  let editorFactory: Function | undefined;
  const ctx = {
    mode: "tui",
    isIdle: () => idle,
    waitForIdle: async () => {
      waits++;
      await gate.promise;
    },
    reload: async () => { reloads++; },
    ui: {
      notify: (text: string) => notices.push(text),
      getEditorComponent: () => editorFactory,
      setEditorComponent: (factory: Function) => { editorFactory = factory; },
    },
  };
  piEnqueuedReload({
    on: (name: string, handler: Function) => events.set(name, handler),
    registerCommand: (name: string, command: { handler: Function }) => commands.set(name, command),
  } as unknown as ExtensionAPI);
  return {
    ctx, events, notices, gate,
    request: () => commands.get("pi-enqueued-reload")!.handler("", ctx),
    setIdle: (value: boolean) => { idle = value; },
    reloads: () => reloads,
    waits: () => waits,
    setFactory: (factory: Function) => { editorFactory = factory; },
    factory: () => editorFactory!,
  };
}

test("reloads immediately when idle", async () => {
  const h = setup();
  await h.request();
  assert.equal(h.reloads(), 1);
  assert.equal(h.waits(), 0);
});

test("coalesces busy requests and reloads once after settling", async () => {
  const h = setup();
  h.setIdle(false);
  const pending = h.request();
  await h.request();
  assert.equal(h.reloads(), 0);
  assert.equal(h.waits(), 1);
  assert.ok(h.notices.length > 0);
  h.setIdle(true);
  h.gate.resolve();
  await pending;
  assert.equal(h.reloads(), 1);
});

test("waits again when another run starts before the idle waiter resumes", async () => {
  const h = setup();
  h.setIdle(false);
  let waits = 0;
  h.ctx.waitForIdle = async () => {
    waits++;
    await h.gate.promise;
    // The first wake loses the idle window to another run.
    if (waits === 2) h.setIdle(true);
  };
  const pending = h.request();
  h.gate.resolve();
  await pending;
  assert.equal(waits, 2);
  assert.equal(h.reloads(), 1);
});

test("shutdown discards a queued request without touching stale context", async () => {
  const h = setup();
  h.setIdle(false);
  const pending = h.request();
  await h.events.get("session_shutdown")!({}, h.ctx);
  h.ctx.isIdle = () => { throw new Error("stale context"); };
  h.gate.resolve();
  await pending;
  assert.equal(h.reloads(), 0);
});

test("reports a failed reload and allows a fresh request", async () => {
  const h = setup();
  const reload = h.ctx.reload;
  h.ctx.reload = async () => { throw new Error("broken extension"); };
  await h.request();
  assert.match(h.notices.join("\n"), /broken extension/);
  h.ctx.reload = reload;
  await h.request();
  assert.equal(h.reloads(), 1);
});

test("wraps the existing editor and changes only an exact /reload submission", async () => {
  const h = setup();
  const submissions: string[] = [];
  const editor = {
    onSubmit: (text: string) => { submissions.push(text); },
    handleInput(text: string) { this.onSubmit(text); },
  };
  h.setFactory(() => editor);
  await h.events.get("session_start")!({}, h.ctx);
  assert.equal(h.factory()({}, {}, {}), editor);
  // Pi assigns onSubmit after the editor factory returns.
  const submit = (text: string) => { submissions.push(text); };
  editor.onSubmit = submit;
  for (const text of [" /reload ", "/reload-other", "hello", "/reload later"]) {
    editor.handleInput(text);
  }
  assert.deepEqual(submissions, ["/pi-enqueued-reload", "/reload-other", "hello", "/reload later"]);
  assert.equal(editor.onSubmit, submit);
});

test("leaves non-TUI editors alone", async () => {
  const h = setup();
  h.ctx.mode = "rpc";
  const factory = () => { throw new Error("must not be called"); };
  h.setFactory(factory);
  await h.events.get("session_start")!({}, h.ctx);
  assert.equal(h.factory(), factory);
});
