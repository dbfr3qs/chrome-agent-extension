import { makeOps } from "./ops.js";
import { Page } from "./snapshot.js";

// Injected repeatedly (once per tool call); keep one set of ops per document so refs stay stable.
const g = globalThis as { __bb?: ReturnType<typeof makeOps> };
g.__bb ??= makeOps(new Page(document));
