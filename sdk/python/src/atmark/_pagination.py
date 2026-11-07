"""Cursor pagination: a list call returns a :class:`Page` — ``page.first()`` gives the raw first response, iterating
walks every item across pages (following ``next_cursor``)."""

from typing import Any, Callable, Dict, Iterator, Optional

PageFetcher = Callable[[Optional[str]], Dict[str, Any]]


class Page:
    def __init__(self, fetch: PageFetcher, items_key: str, cursor: Optional[str] = None) -> None:
        self._fetch = fetch
        self._items_key = items_key
        self._cursor = cursor

    def first(self) -> Dict[str, Any]:
        """The first page as returned by the API (includes ``next_cursor``)."""
        return self._fetch(self._cursor)

    def pages(self) -> Iterator[Dict[str, Any]]:
        cursor = self._cursor
        while True:
            page = self._fetch(cursor)
            yield page
            following = page.get("next_cursor") if isinstance(page, dict) else None
            if not following or following == cursor:
                return
            cursor = following

    def __iter__(self) -> Iterator[Dict[str, Any]]:
        for page in self.pages():
            items = page.get(self._items_key) if isinstance(page, dict) else None
            for item in items or []:
                yield item
