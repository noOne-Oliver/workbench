import { registerProvider } from "../engine.mjs";
import createMock from "./mock.mjs";
import createOpencode from "./opencode.mjs";

registerProvider("mock", createMock);
registerProvider("opencode", createOpencode);

export const BUILTIN_ENGINES = ["mock", "opencode"];
