"""Strict, stdlib-only OpenGraph / Twitter-card / ``<title>`` parser.

The goal is to extract a small fixed set of fields out of arbitrary HTML
without pulling in BeautifulSoup or selectolax. ``html.parser`` is plenty
capable for the four tag shapes we care about (``<meta>``, ``<title>``,
``<link rel="canonical">``, ``<base>``), and the resulting parser stops
walking the document as soon as it has either filled every slot or hit
``</head>`` — most pages emit OG in the first ~5KB, so we rarely scan a
full page.

Field priority mirrors what Slack / Discord / Telegram do:

* ``title``: ``og:title`` → ``twitter:title`` → ``<title>``
* ``description``: ``og:description`` → ``twitter:description`` →
  ``<meta name="description">``
* ``image``: ``og:image:secure_url`` → ``og:image`` → ``twitter:image``
* ``site_name``: ``og:site_name``
* ``canonical``: ``<link rel="canonical">`` → ``og:url``
* ``base_href``: ``<base href>`` — used to resolve relative ``image``
  URLs into absolute ones at the parse step, so callers don't have to
  carry the original document URL around.

The parser is intentionally forgiving: missing fields come back as
``None`` rather than raising; unknown ``property`` / ``name`` values are
ignored; quotes and case in tag attributes don't matter because
``html.parser`` normalizes them.
"""
from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import urljoin


@dataclass
class ParsedPreview:
    """Raw fields extracted from a single HTML document.

    All values are unescaped, stripped, and (for ``image``) resolved to
    an absolute URL. ``canonical`` is *not* resolved against ``base_href``
    because OG canonical URLs are typically absolute already; callers
    resolve against the request URL as a fallback.
    """

    title: str | None = None
    description: str | None = None
    image: str | None = None
    site_name: str | None = None
    canonical: str | None = None


class _OgHtmlParser(HTMLParser):
    """``HTMLParser`` subclass that snapshots the OG-shaped tags it sees.

    Designed to be stopped early — once ``done()`` returns True the
    caller can break out of the feed loop instead of paying to parse the
    rest of the document. This matters for big pages (news sites with
    ad-tech bloat are routinely 1MB+ of HTML, but their OG meta is in
    the first few KB).
    """

    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self._base_url = base_url
        # ``base_href`` defaults to the request URL; <base href="..."> at
        # the top of <head> can override it.
        self._effective_base = base_url
        # Cached field slots — first non-empty win, then we ignore further
        # writes (OG cards typically don't repeat tags, but pages do
        # sometimes ship both ``og:title`` and an older ``twitter:title``).
        self.og_title: str | None = None
        self.tw_title: str | None = None
        self.html_title: str | None = None
        self.og_description: str | None = None
        self.tw_description: str | None = None
        self.html_description: str | None = None
        self.og_image: str | None = None
        self.og_image_secure: str | None = None
        self.tw_image: str | None = None
        self.og_site_name: str | None = None
        self.og_url: str | None = None
        self.link_canonical: str | None = None
        self._in_title = False
        self._title_buf: list[str] = []
        # When True the feed loop should stop. Triggered by ``</head>``
        # (the data we want lives in <head>) or once every slot is filled.
        self._stop = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self._stop:
            return
        tag = tag.lower()
        if tag == "meta":
            self._handle_meta(dict(attrs))
        elif tag == "link":
            self._handle_link(dict(attrs))
        elif tag == "base":
            href = dict(attrs).get("href")
            if href:
                self._effective_base = urljoin(self._base_url, href)
        elif tag == "title":
            self._in_title = True

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "title":
            self._in_title = False
            if self._title_buf:
                self.html_title = "".join(self._title_buf).strip() or None
                self._title_buf = []
        elif tag == "head":
            self._stop = True

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self._title_buf.append(data)

    def done(self) -> bool:
        """True once we've seen ``</head>`` or filled every wanted slot."""
        if self._stop:
            return True
        return (
            (self.og_title or self.tw_title or self.html_title) is not None
            and (
                self.og_description
                or self.tw_description
                or self.html_description
            )
            is not None
            and (self.og_image or self.og_image_secure or self.tw_image)
            is not None
            and self.og_site_name is not None
        )

    def _handle_meta(self, attrs: dict[str, str | None]) -> None:
        prop = (attrs.get("property") or "").lower()
        name = (attrs.get("name") or "").lower()
        content = (attrs.get("content") or "").strip() or None
        if content is None:
            return
        if prop == "og:title" and self.og_title is None:
            self.og_title = content
        elif prop == "og:description" and self.og_description is None:
            self.og_description = content
        elif prop == "og:image" and self.og_image is None:
            self.og_image = self._resolve(content)
        elif prop == "og:image:secure_url" and self.og_image_secure is None:
            self.og_image_secure = self._resolve(content)
        elif prop == "og:site_name" and self.og_site_name is None:
            self.og_site_name = content
        elif prop == "og:url" and self.og_url is None:
            self.og_url = content
        elif name == "twitter:title" and self.tw_title is None:
            self.tw_title = content
        elif name == "twitter:description" and self.tw_description is None:
            self.tw_description = content
        elif name == "twitter:image" and self.tw_image is None:
            self.tw_image = self._resolve(content)
        elif name == "description" and self.html_description is None:
            self.html_description = content

    def _handle_link(self, attrs: dict[str, str | None]) -> None:
        rel = (attrs.get("rel") or "").lower()
        href = (attrs.get("href") or "").strip() or None
        if rel == "canonical" and href and self.link_canonical is None:
            self.link_canonical = self._resolve(href)

    def _resolve(self, url: str) -> str:
        # ``urljoin`` correctly handles absolute, scheme-relative, and
        # path-relative URLs against the effective base.
        return urljoin(self._effective_base, url)


def parse_preview(html: str, source_url: str) -> ParsedPreview:
    """Parse OG / Twitter / fallback meta out of ``html``.

    ``source_url`` is used as the base for resolving relative image URLs
    when the page doesn't carry a ``<base href>`` tag. Returns a
    populated ``ParsedPreview`` — empty fields stay as ``None``.

    The parser walks the document until ``</head>`` or until every slot
    is filled, so the work is bounded by the size of the head section
    rather than the full document.
    """
    parser = _OgHtmlParser(source_url)
    # Feed in small chunks so we can early-out as soon as the parser
    # signals it's done — saves real time on pages with multi-MB bodies.
    chunk = 8192
    for i in range(0, len(html), chunk):
        parser.feed(html[i : i + chunk])
        if parser.done():
            break
    try:
        parser.close()
    except Exception:
        # Some pages emit malformed HTML that trips the parser's
        # finalizer (unclosed CDATA etc.). Whatever we've collected so
        # far is still valid; don't punish the caller for a buggy site.
        pass

    title = parser.og_title or parser.tw_title or parser.html_title
    description = (
        parser.og_description
        or parser.tw_description
        or parser.html_description
    )
    image = parser.og_image_secure or parser.og_image or parser.tw_image
    canonical = parser.link_canonical or parser.og_url
    return ParsedPreview(
        title=_clean(title),
        description=_clean(description),
        image=image,
        site_name=_clean(parser.og_site_name),
        canonical=canonical,
    )


def _clean(text: str | None) -> str | None:
    if text is None:
        return None
    # Collapse runs of whitespace (incl. newlines from multi-line
    # ``content`` attributes) so the rendered card never has weird
    # spacing.
    out = " ".join(text.split())
    return out or None
