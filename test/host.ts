/**
 * A stub pi host, enough to drive the extension's own wiring in a test.
 *
 * The src/ helpers prove a verdict; this proves the verdict is *reached* —
 * that a tool_call with the right toolName gets to evaluateCommand at all.
 * The powershell hole was exactly the kind of bug a helper test cannot see:
 * every rule was right, and the extension never asked them.
 *
 * Headless by default (hasUI: false), so ASK tiers fail closed to a deny and
 * no dialog needs answering. Tests that want a yes wire `confirm` themselves.
 */

export interface Entry {
  type: "custom";
  customType: string;
  data: unknown;
}

export interface StubOptions {
  cwd?: string;
  hasUI?: boolean;
  /** Answer every confirm dialog with this; default true. */
  confirm?: boolean;
}

export class StubHost {
  readonly commands = new Map<string, (args: string, ctx: unknown) => Promise<void> | void>();
  readonly handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown> | unknown>();
  readonly entries: Entry[] = [];
  readonly notices: Array<{ message: string; level: string }> = [];
  readonly confirms: Array<{ title: string; message: string }> = [];

  private readonly opts: StubOptions;

  constructor(opts: StubOptions = {}) {
    this.opts = opts;
  }

  /** The `pi` object handed to the extension factory. */
  get api(): Record<string, unknown> {
    return {
      registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> | void }) => {
        this.commands.set(name, spec.handler);
      },
      registerTool: () => {},
      on: (event: string, handler: (e: unknown, c: unknown) => Promise<unknown> | unknown) => {
        this.handlers.set(event, handler);
      },
      appendEntry: (customType: string, data: unknown) => {
        this.entries.push({ type: "custom", customType, data });
      },
    };
  }

  /** The context handed to command handlers and event hooks. */
  get ctx(): Record<string, unknown> {
    return {
      cwd: this.opts.cwd ?? "/repo",
      hasUI: this.opts.hasUI ?? false,
      isProjectTrusted: () => true,
      sessionManager: {
        getBranch: () => this.entries,
        getLeafId: () => null,
      },
      ui: {
        notify: (message: string, level: string) => {
          this.notices.push({ message, level });
        },
        setStatus: () => {},
        confirm: async (title: string, message: string) => {
          this.confirms.push({ title, message });
          return this.opts.confirm ?? true;
        },
        input: async () => "",
      },
    };
  }

  async run(command: string, args = ""): Promise<void> {
    const handler = this.commands.get(command);
    if (!handler) throw new Error(`No command /${command} registered. Have: ${[...this.commands.keys()].join(", ")}`);
    await handler(args, this.ctx);
  }

  async fire(event: string, payload: unknown = {}): Promise<unknown> {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`No handler for ${event}`);
    return handler(payload, this.ctx);
  }

  /** A tool_call as pi delivers it; the hook's return is the gate's answer. */
  async toolCall(toolName: string, input: Record<string, unknown>): Promise<{ block?: boolean; reason?: string } | undefined> {
    return (await this.fire("tool_call", { type: "tool_call", toolCallId: "t1", toolName, input })) as
      | { block?: boolean; reason?: string }
      | undefined;
  }

  /** A tool_result as pi delivers it; the hook may hand back replacement content. */
  async toolResult(
    toolName: string,
    input: Record<string, unknown>,
    text: string,
    isError = false,
  ): Promise<{ content?: Array<{ type: string; text?: string }> } | undefined> {
    return (await this.fire("tool_result", {
      type: "tool_result",
      toolCallId: "t1",
      toolName,
      input,
      content: [{ type: "text", text }],
      isError,
    })) as { content?: Array<{ type: string; text?: string }> } | undefined;
  }
}
