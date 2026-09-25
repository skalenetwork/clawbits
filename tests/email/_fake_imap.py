"""An RFC 3501-faithful in-memory IMAP mailbox for unit tests of ``clawbits.email.imap_client``."""
from __future__ import annotations

RAW = b"From: a@example.com\r\nTo: b@example.com\r\nSubject: s\r\n\r\nbody\r\n"


class FakeImap:
    """INBOX with UIDVALIDITY/UIDNEXT, UID-range SEARCH (including '*'), FETCH and an audit trail.

    ``on_search`` / ``on_fetch`` hooks mutate the mailbox between protocol steps. Every FETCH also
    carries an unsolicited record for the newest message, as a server may send.
    """

    def __init__(self, uids=(), uidvalidity: int = 100, raw: bytes = RAW):
        self.uidvalidity = uidvalidity
        self.msgs: dict[int, dict] = {u: {"flags": set(), "raw": raw} for u in uids}
        self.uidnext = max(uids, default=0) + 1
        self.selects: list[bool] = []
        self.searches: list[list[str]] = []
        self.fetches: list[list[str]] = []
        self.flag_writes = 0
        self.deletes = 0
        self.expunges = 0
        self.on_search = None
        self.on_fetch = None

    def deliver(self, n: int = 1, raw: bytes = RAW) -> None:
        for _ in range(n):
            self.msgs[self.uidnext] = {"flags": set(), "raw": raw}
            self.uidnext += 1

    def reset(self) -> None:
        """Recreate the mailbox: a new epoch whose UIDs start again at 1."""
        self.uidvalidity += 1
        self.msgs, self.uidnext = {}, 1

    def select_folder(self, folder, readonly=False):
        assert folder == "INBOX"
        self.selects.append(readonly)
        return {b"UIDVALIDITY": self.uidvalidity, b"UIDNEXT": self.uidnext, b"EXISTS": len(self.msgs)}

    def capabilities(self):
        return (b"IMAP4REV1",)

    def search(self, criteria):
        self.searches.append(list(criteria))
        if self.on_search:
            self.on_search(self)
        assert criteria[0] == "UID"
        lo, hi = criteria[1].split(":")
        star = max(self.msgs, default=0)
        lo, hi = int(lo), (star if hi == "*" else int(hi))
        lo, hi = min(lo, hi), max(lo, hi)  # RFC 3501: n:m is the same set as m:n
        return [u for u in self.msgs if lo <= u <= hi]

    def fetch(self, uids, items):
        self.fetches.append(list(items))
        if self.on_fetch:
            self.on_fetch(self)
        out = {}
        for uid in uids:
            if uid not in self.msgs:
                continue
            msg = self.msgs[uid]
            record = {b"FLAGS": tuple(msg["flags"]), b"RFC822.SIZE": len(msg["raw"])}
            if "RFC822" in items:
                msg["flags"].add(b"\\Seen")
                record[b"RFC822"] = msg["raw"]
            if "BODY.PEEK[]" in items:
                record[b"BODY[]"] = msg["raw"]
            out[uid] = record
        if self.msgs:
            out.setdefault(max(self.msgs), {b"FLAGS": (), b"RFC822.SIZE": 1})
        return out

    def add_flags(self, uids, flags):
        self.flag_writes += 1
        for uid in uids:
            self.msgs[uid]["flags"].update(flags)

    def delete_messages(self, uids):
        self.deletes += 1

    def expunge(self):
        self.expunges += 1

