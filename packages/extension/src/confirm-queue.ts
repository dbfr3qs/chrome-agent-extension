export interface ConfirmDetails {
  id: string;
  tool: string;
  site: string;
  tabUrl: string;
  /** What is being acted on, e.g. `button "Save" (submits form)`. */
  label?: string;
  reason: string;
  args: Record<string, unknown>;
  form?: { action: string; method: string; fields: { name: string; value: string }[] };
}

export interface PendingView extends ConfirmDetails {
  expiresAt: number;
}

export type Outcome = "approve" | "deny" | "timeout" | "cancel";

/** Pending human confirmations. No Chrome APIs here so the timeout/decision rules are unit-testable. */
export class ConfirmQueue {
  private items = new Map<string, { view: PendingView; resolve: (o: Outcome) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private onChange: (pending: PendingView[]) => void = () => {}) {}

  request(details: ConfirmDetails, timeoutMs: number): Promise<Outcome> {
    return new Promise((resolve) => {
      const view: PendingView = { ...details, expiresAt: Date.now() + timeoutMs };
      const timer = setTimeout(() => this.settle(details.id, "timeout"), timeoutMs);
      this.items.set(details.id, { view, resolve, timer });
      this.onChange(this.list());
    });
  }

  /** Returns false if the id is unknown or already settled. Unanswered means deny: only an explicit approve approves. */
  respond(id: string, approve: boolean): boolean {
    return this.settle(id, approve ? "approve" : "deny");
  }

  /** The requester went away; the request must not be answerable afterwards. */
  cancel(id: string): boolean {
    return this.settle(id, "cancel");
  }

  list(): PendingView[] {
    return [...this.items.values()].map((i) => i.view);
  }

  private settle(id: string, outcome: Outcome): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    clearTimeout(item.timer);
    this.items.delete(id);
    item.resolve(outcome);
    this.onChange(this.list());
    return true;
  }
}
