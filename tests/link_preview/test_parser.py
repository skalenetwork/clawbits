"""Parser tests — pure functions, no network or DB."""
from __future__ import annotations

from clawbits.link_preview.parser import parse_preview

BASE = "https://example.com/blog/post"


def test_extracts_full_opengraph():
    html = """
    <!doctype html>
    <html><head>
      <meta property="og:title" content="My OG Title"/>
      <meta property="og:description" content="A short description."/>
      <meta property="og:image" content="https://cdn.example.com/img.png"/>
      <meta property="og:site_name" content="Example Blog"/>
      <meta property="og:url" content="https://example.com/canonical"/>
    </head><body><h1>Article</h1></body></html>
    """
    p = parse_preview(html, BASE)
    assert p.title == "My OG Title"
    assert p.description == "A short description."
    assert p.image == "https://cdn.example.com/img.png"
    assert p.site_name == "Example Blog"
    assert p.canonical == "https://example.com/canonical"


def test_twitter_fallback_when_og_missing():
    html = """
    <html><head>
      <meta name="twitter:title" content="Tweet Title"/>
      <meta name="twitter:description" content="Tweet desc"/>
      <meta name="twitter:image" content="https://cdn.example.com/t.png"/>
    </head></html>
    """
    p = parse_preview(html, BASE)
    assert p.title == "Tweet Title"
    assert p.description == "Tweet desc"
    assert p.image == "https://cdn.example.com/t.png"
    assert p.site_name is None


def test_html_title_fallback_when_no_meta():
    html = """
    <html><head>
      <title>Plain HTML Title</title>
    </head></html>
    """
    p = parse_preview(html, BASE)
    assert p.title == "Plain HTML Title"
    assert p.description is None
    assert p.image is None


def test_description_falls_back_to_meta_description():
    html = """
    <html><head>
      <title>X</title>
      <meta name="description" content="Bare HTML description."/>
    </head></html>
    """
    p = parse_preview(html, BASE)
    assert p.description == "Bare HTML description."


def test_og_wins_over_twitter_and_html():
    html = """
    <html><head>
      <title>HTML T</title>
      <meta name="twitter:title" content="Tweet T"/>
      <meta property="og:title" content="OG T"/>
    </head></html>
    """
    p = parse_preview(html, BASE)
    assert p.title == "OG T"


def test_secure_image_wins_over_plain_og_image():
    html = """
    <html><head>
      <meta property="og:image" content="http://cdn.example.com/insecure.png"/>
      <meta property="og:image:secure_url" content="https://cdn.example.com/secure.png"/>
    </head></html>
    """
    p = parse_preview(html, BASE)
    assert p.image == "https://cdn.example.com/secure.png"


def test_relative_image_resolved_against_source_url():
    html = """
    <html><head>
      <meta property="og:image" content="/images/og.png"/>
    </head></html>
    """
    p = parse_preview(html, "https://example.com/blog/post")
    assert p.image == "https://example.com/images/og.png"


def test_relative_image_resolved_against_base_href():
    html = """
    <html><head>
      <base href="https://cdn.example.com/v2/"/>
      <meta property="og:image" content="og.png"/>
    </head></html>
    """
    p = parse_preview(html, "https://example.com/blog/post")
    assert p.image == "https://cdn.example.com/v2/og.png"


def test_link_canonical_wins_over_og_url():
    html = """
    <html><head>
      <meta property="og:url" content="https://example.com/og-url"/>
      <link rel="canonical" href="https://example.com/real-canonical"/>
    </head></html>
    """
    p = parse_preview(html, BASE)
    assert p.canonical == "https://example.com/real-canonical"


def test_whitespace_in_content_is_collapsed():
    html = """
    <html><head>
      <meta property="og:title" content="  My   Title

      Newlines  "/>
    </head></html>
    """
    p = parse_preview(html, BASE)
    assert p.title == "My Title Newlines"


def test_no_metadata_returns_all_none():
    p = parse_preview("<html><body>just text</body></html>", BASE)
    assert p.title is None
    assert p.description is None
    assert p.image is None
    assert p.site_name is None
    assert p.canonical is None


def test_malformed_html_does_not_crash():
    # Unclosed tags, stray <, etc. — html.parser should keep going.
    html = "<html><head><meta property='og:title' content='OK'><body><p>oops</html>"
    p = parse_preview(html, BASE)
    assert p.title == "OK"


def test_parser_stops_after_head_close():
    # Body contains a deceptive og:title — must be ignored because we
    # only scan <head>.
    html = """
    <html><head>
      <meta property="og:title" content="Real Title"/>
    </head><body>
      <meta property="og:title" content="Fake Title"/>
    </body></html>
    """
    p = parse_preview(html, BASE)
    assert p.title == "Real Title"
