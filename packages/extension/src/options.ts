/// <reference types="chrome" />
import { DEFAULT_POLICY, PolicySchema } from "./policy/schema.js";
import { loadPolicy, savePolicy } from "./policy/store.js";

const editor = document.getElementById("editor") as HTMLTextAreaElement;
const status = document.getElementById("status") as HTMLElement;
const show = (msg: string, ok: boolean) => {
  status.textContent = msg;
  status.className = ok ? "ok" : "bad";
};

async function load(): Promise<void> {
  editor.value = JSON.stringify(await loadPolicy(), null, 2);
}

function validate(): ReturnType<typeof PolicySchema.safeParse> {
  let json: unknown;
  try {
    json = JSON.parse(editor.value);
  } catch (e) {
    show(`Invalid JSON: ${(e as Error).message}`, false);
    return { success: false } as never;
  }
  const r = PolicySchema.safeParse(json);
  if (!r.success) show(r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"), false);
  return r;
}

document.getElementById("validate")!.addEventListener("click", () => {
  if (validate().success) show("Policy is valid.", true);
});
document.getElementById("save")!.addEventListener("click", async () => {
  const r = validate();
  if (!r.success) return;
  await savePolicy(r.data);
  editor.value = JSON.stringify(r.data, null, 2);
  show("Saved. Applies to the next request.", true);
});
document.getElementById("reset")!.addEventListener("click", () => {
  editor.value = JSON.stringify(DEFAULT_POLICY, null, 2);
  show("Default (deny-all) loaded; press Save to apply.", true);
});
void load();
