"""list_changes / flag-neutral get_email / epoch checks against an RFC-faithful fake IMAP server."""
import pytest

from clawbits.email import imap_client
from clawbits.email.imap_client import MailboxEpochChanged, list_changes
from tests.email._fake_imap import FakeImap


def drain(after=0, uidvalidity=None, limit=50):
    """One full client scan; returns (uids seen in order, final cursor, epoch)."""
    seen, through = [], None
    while True:
        page = list_changes("a", after, uidvalidity=uidvalidity, through_uid=through, limit=limit)
        uidvalidity, through = page["uidvalidity"], page["through_uid"]
        got = [e["uid"] for e in page["emails"]]
        assert got == sorted(got) and all(after < u <= through for u in got)
        assert page["next_after_uid"] >= after
        seen += got
        after = page["next_after_uid"]
        if not page["has_more"]:
            return seen, after, uidvalidity


@pytest.mark.parametrize("n", [1002, 10_000])
def test_changes_drains_large_mailbox_without_skips(patch_imap, n):
    fake = patch_imap(FakeImap(range(1, n + 1)))
    seen, cursor, _ = drain(limit=50)
    assert seen == list(range(1, n + 1)) and cursor == n
    assert set(fake.selects) == {True}
    assert fake.flag_writes == 0


def test_changes_sparse_uids(patch_imap):
    uids = [3, 4, 17, 90, 91, 5000]
    patch_imap(FakeImap(uids))
    seen, cursor, _ = drain(limit=2)
    assert seen == uids and cursor == 5000


def test_changes_arrivals_during_scan_deferred_to_next_scan(patch_imap):
    fake = patch_imap(FakeImap(range(1, 121)))
    fake.on_search = lambda f: f.deliver(5)
    seen, cursor, epoch = drain(limit=50)
    assert seen == list(range(1, 121)) and cursor == 120
    fake.on_search = None
    seen2, cursor2, _ = drain(after=cursor, uidvalidity=epoch)
    assert seen2 == list(range(121, fake.uidnext)) and cursor2 == fake.uidnext - 1


def test_changes_deletion_between_search_and_fetch_passed_over(patch_imap):
    fake = patch_imap(FakeImap(range(1, 101)))
    fake.on_fetch = lambda f: f.msgs.pop(10, None)
    seen, cursor, _ = drain(limit=20)
    assert seen == [u for u in range(1, 101) if u != 10] and cursor == 100


def test_changes_never_uses_star_range(patch_imap):
    fake = patch_imap(FakeImap([1, 2, 3]))
    assert fake.search(["UID", "5:*"]) == [3]
    page = list_changes("a", 3)
    assert page["emails"] == [] and page["next_after_uid"] == 3 and page["has_more"] is False
    drain()
    assert all("*" not in term for criteria in fake.searches[1:] for term in criteria)


def test_changes_empty_mailbox(patch_imap):
    fake = patch_imap(FakeImap([]))
    assert list_changes("a") == {
        "uidvalidity": 100,
        "through_uid": 0,
        "emails": [],
        "next_after_uid": 0,
        "has_more": False,
    }
    assert fake.searches == [] and fake.fetches == []


def test_changes_epoch_mismatch_raises_with_current(patch_imap):
    fake = patch_imap(FakeImap(range(1, 10)))
    _, cursor, epoch = drain()
    fake.reset()
    fake.deliver(3)
    searches = len(fake.searches)
    with pytest.raises(MailboxEpochChanged) as exc:
        list_changes("a", cursor, uidvalidity=epoch)
    assert exc.value.uidvalidity == epoch + 1
    assert len(fake.searches) == searches


def test_changes_through_uid_clamped_and_unsolicited_fetch_ignored(patch_imap):
    patch_imap(FakeImap(range(1, 6)))
    page = list_changes("a", 0, through_uid=10_000, limit=2)
    assert page["through_uid"] == 5
    assert [e["uid"] for e in page["emails"]] == [1, 2]
    assert page["next_after_uid"] == 2 and page["has_more"] is True


def test_changes_negative_after_uid_is_zero(patch_imap):
    patch_imap(FakeImap(range(1, 4)))
    page = list_changes("a", -5)
    assert [e["uid"] for e in page["emails"]] == [1, 2, 3] and page["next_after_uid"] == 3


def test_get_email_peek_is_flag_neutral(patch_imap):
    fake = patch_imap(FakeImap([1, 2]))
    detail = imap_client.get_email("a", 1, mark_read=False)
    assert detail["is_read"] is False and detail["body_text"].strip() == "body"
    assert fake.selects == [True]
    assert "BODY.PEEK[]" in fake.fetches[0] and "RFC822" not in fake.fetches[0]
    assert fake.flag_writes == 0 and fake.msgs[1]["flags"] == set()
    fake.msgs[2]["flags"].add(b"\\Seen")
    assert imap_client.get_email("a", 2, mark_read=False)["is_read"] is True


def test_get_email_default_path_unchanged(patch_imap):
    fake = patch_imap(FakeImap([1]))
    detail = imap_client.get_email("a", 1)
    assert detail["is_read"] is True
    assert fake.selects == [False]
    assert "RFC822" in fake.fetches[0]
    assert b"\\Seen" in fake.msgs[1]["flags"]
    assert imap_client.get_email("a", 99) is None


def test_detail_and_delete_epoch_mismatch_raise_before_side_effects(patch_imap):
    fake = patch_imap(FakeImap([1], uidvalidity=7))
    with pytest.raises(MailboxEpochChanged) as exc:
        imap_client.get_email("a", 1, uidvalidity=6)
    assert exc.value.uidvalidity == 7
    with pytest.raises(MailboxEpochChanged):
        imap_client.delete_email("a", 1, uidvalidity=6)
    assert fake.fetches == [] and fake.deletes == 0 and fake.expunges == 0
    assert imap_client.get_email("a", 1, uidvalidity=7, mark_read=False)["uid"] == 1
    assert imap_client.delete_email("a", 1, uidvalidity=7) is True
