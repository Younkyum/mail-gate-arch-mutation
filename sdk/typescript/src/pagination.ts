/**
 * Cursor pagination. A list call returns a `PageRequest`:
 *   - `await client.messages.inbound.list({...})` gives the first page (the raw response, with `next_cursor`);
 *   - `for await (const m of client.messages.inbound.list({...}))` walks every item across pages, following `next_cursor`.
 */

export type PageFetcher<P> = (cursor: string | undefined) => Promise<P>;

export class PageRequest<P extends { readonly next_cursor?: string | null }, Item> implements PromiseLike<P>, AsyncIterable<Item> {
  constructor(
    private readonly fetchPage: PageFetcher<P>,
    private readonly itemsOf: (page: P) => readonly Item[],
    private readonly firstCursor: string | undefined,
  ) {}

  then<A = P, B = never>(onFulfilled?: ((value: P) => A | PromiseLike<A>) | null, onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    return this.fetchPage(this.firstCursor).then(onFulfilled, onRejected);
  }

  /** Every page, in order. */
  async *pages(): AsyncGenerator<P, void, undefined> {
    let cursor = this.firstCursor;
    for (;;) {
      const page = await this.fetchPage(cursor);
      yield page;
      const next = page.next_cursor;
      if (next === null || next === undefined || next === '' || next === cursor) return;
      cursor = next;
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Item, void, undefined> {
    for await (const page of this.pages()) yield* this.itemsOf(page);
  }
}
