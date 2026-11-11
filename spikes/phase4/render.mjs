// Phase 4 spike: can a host process render Pi's own chat components outside InteractiveMode?
// Run: node spikes/phase4/render.mjs
import { AssistantMessageComponent, CustomMessageComponent, getMarkdownTheme, getSelectListTheme, initTheme, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, Editor, ScrollView, stripTerminalSequences, TuiAltScreen, VStack } from "@earendil-works/pi-tui";

const writes = [];
const terminal = {
	start() {}, stop() {}, async drainInput() {}, write: (d) => writes.push(d), columns: 100, rows: 30, kittyProtocolActive: false,
	moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
};
initTheme(undefined, false);
const tui = new TuiAltScreen(terminal);
const md = getMarkdownTheme();
const transcript = new Container();
transcript.addChild(new UserMessageComponent("Please list the files", md));
const assistant = { role: "assistant", content: [{ type: "text", text: "Sure, **listing** now." }, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse", timestamp: Date.now() };
transcript.addChild(new AssistantMessageComponent(assistant, false, md));
const tool = new ToolExecutionComponent("bash", "t1", { command: "ls" }, {}, undefined, tui, process.cwd());
tool.markExecutionStarted();
tool.setArgsComplete();
tool.updateResult({ content: [{ type: "text", text: "README.md\npackage.json" }], isError: false });
transcript.addChild(tool);
transcript.addChild(new CustomMessageComponent({ role: "custom", customType: "lattice-a2a", content: "<lattice-message>hi</lattice-message>", display: true, timestamp: Date.now() }, undefined, md));
const editor = new Editor(tui, { borderColor: (text) => `\x1b[2m${text}\x1b[22m`, selectList: getSelectListTheme() });
tui.setLayoutRoot(new VStack([{ component: new ScrollView(transcript, { follow: "end", primary: true }), basis: 0, grow: 1, minSize: 1 }, { component: editor, basis: "auto", shrink: 1, minSize: 1 }]));
const lines = transcript.render(100).map((l) => stripTerminalSequences(l));
console.log(lines.join("\n"));
tui.start(); tui.renderNow(true); tui.stop();
const ok = ["Please list the files", "listing", "ls", "README.md", "lattice-message"].every((s) => lines.join("\n").includes(s));
console.log(ok ? `\nPASS components render outside InteractiveMode (${writes.length} terminal writes)` : "\nFAIL");
process.exit(ok ? 0 : 1);
