"""The guest env-file codec, and where each runtime puts that file with which
modes."""

import asyncio
import base64
import os
import stat
from pathlib import Path

import pytest

from reef import Limits, SandboxSpec
from reef.docker_runtime import DockerRuntime
from reef.guest_env import (
    ENV_FILENAME,
    EnvRecord,
    parse,
    read_env_file,
    serialize,
    write_env_file,
)
from reef.microsandbox_runtime import MicrosandboxRuntime

# Every value here is legal: ``fleet._validate_user_env`` permits anything but a
# NUL and a trailing newline, which is why the file is base64 and not shell.
NASTY_VALUES = [
    "plain",
    "",
    " leading and trailing ",
    "line one\nline two\n",
    "quote ' and \" and \\ and $ and `",
    "`id` $(id) ${HOME} $HOME",
    "semi; colon && amp | pipe > redir",
    "tab\there",
    "юникод 🦀 ünïcödé",
    "=not=a=delimiter=",
    "a" * 4096,
]


def _roundtrip(records: list[EnvRecord]) -> list[EnvRecord]:
    return parse(serialize(records))


def test_roundtrips_every_nasty_value():
    records = [EnvRecord("s", f"K{i}", v) for i, v in enumerate(NASTY_VALUES)]
    assert _roundtrip(records) == records


def test_unset_and_empty_set_are_distinct():
    records = [EnvRecord("u", "GONE"), EnvRecord("s", "EMPTY", "")]
    assert _roundtrip(records) == records


def test_order_and_duplicates_are_preserved():
    # Last-one-wins is the guest's `export` behaviour; the codec must not collapse.
    records = [EnvRecord("s", "K", "first"), EnvRecord("s", "K", "second")]
    assert _roundtrip(records) == records


def test_file_shape_is_the_v1_line_format():
    text = serialize([EnvRecord("s", "AGENTPIT_API_KEY", "sk-live-example"), EnvRecord("u", "OLD")])
    lines = text.splitlines()
    assert lines[0].startswith("# reef guest env v1")
    assert lines[1] == "v1"
    assert lines[2] == f"s AGENTPIT_API_KEY {base64.b64encode(b'sk-live-example').decode()}"
    assert lines[3] == "u OLD"
    assert text.endswith("\n")
    assert "sk-live-example" not in text


def test_serialize_rejects_unrepresentable_records():
    # A key with a space or a newline would otherwise inject a second record.
    for key in ("A B", "A\ns EVIL", "", "1LEADING_DIGIT", "WITH-DASH", "lower ok but space "):
        with pytest.raises(ValueError):
            serialize([EnvRecord("s", key, "v")])
    with pytest.raises(ValueError):
        serialize([EnvRecord("x", "K", "v")])  # type: ignore[arg-type]


def test_parse_skips_malformed_lines_without_raising():
    good = serialize([EnvRecord("s", "GOOD", "yes")]).splitlines()[-1]
    text = "\n".join(
        [
            "# a comment",
            "v1",
            "",
            "   ",
            "garbage",
            "s",  # no key
            "x KEY dmFs",  # unknown op
            "s 1BAD dmFs",  # key starts with a digit
            "s BAD-KEY dmFs",  # key charset
            "s BADB64 !!!!",  # undecodable value
            "s TOOMANY dmFs extra",  # trailing junk the guest would fail to decode
            "u UNSETME extra",  # unset takes no value
            good,
        ]
    )
    assert parse(text) == [EnvRecord("s", "GOOD", "yes")]


def test_parse_ignores_an_oversized_file():
    text = serialize([EnvRecord("s", "K", "v")]) + ("# pad\n" * 100_000)
    assert parse(text) == []


def test_write_then_read_round_trips_and_leaves_no_tmp_file(tmp_path):
    d = tmp_path / "env" / "agent-1"
    write_env_file(d, [EnvRecord("s", "AGENTPIT_API_KEY", "superseded")])
    records = [EnvRecord("s", "AGENTPIT_API_KEY", "sk-live\nsecret"), EnvRecord("u", "OLD")]
    write_env_file(d, records)
    assert read_env_file(d) == records
    assert sorted(p.name for p in d.iterdir()) == [ENV_FILENAME]


def test_write_leaves_nothing_behind_when_a_record_is_invalid(tmp_path):
    d = tmp_path / "env" / "agent-1"
    with pytest.raises(ValueError):
        write_env_file(d, [EnvRecord("s", "BAD KEY", "v")])
    assert list(d.iterdir()) == []


def test_modes_let_the_guests_non_root_uid_read_it(tmp_path):
    # Under a tight umask the file would land 0600 and the agent (uid 1000) could
    # not read its own env.
    previous = os.umask(0o077)
    try:
        d = tmp_path / "env" / "agent-1"
        write_env_file(d, [EnvRecord("s", "K", "v")])
        assert stat.S_IMODE((d / ENV_FILENAME).stat().st_mode) == 0o644
        assert stat.S_IMODE(d.stat().st_mode) == 0o755
        assert stat.S_IMODE(d.parent.stat().st_mode) == 0o700
    finally:
        os.umask(previous)


def test_write_does_not_repermission_an_existing_parent(tmp_path):
    parent = tmp_path / "volumes"
    parent.mkdir(mode=0o755)
    write_env_file(parent / "reef-env-agent-1", [EnvRecord("s", "K", "v")])
    assert stat.S_IMODE(parent.stat().st_mode) == 0o755


def test_read_reports_a_missing_or_corrupt_file_as_none(tmp_path):
    # None ("no overlay at all") is distinct from [] ("a file with no records").
    assert read_env_file(tmp_path / "nope") is None
    empty = tmp_path / "empty"
    empty.mkdir()
    (empty / ENV_FILENAME).write_text("")
    assert read_env_file(empty) == []
    corrupt = tmp_path / "corrupt"
    corrupt.mkdir()
    (corrupt / ENV_FILENAME).write_bytes(b"\xff\xfe not utf-8 at all")
    assert read_env_file(corrupt) is None


GUEST_ENV_DIR = "/home/node/.reef-env"  # OpenClawProfile.env_dir


class _FakeCli:
    """Records argv and succeeds at everything."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    async def __call__(self, argv):
        self.calls.append(list(argv))
        return (0, "", "")

    def mount_for(self, dest: str) -> str:
        """The one ``-v`` argument that targets ``dest``, verbatim."""
        for argv in self.calls:
            for flag, value in zip(argv, argv[1:], strict=False):
                if flag == "-v" and value.split(":")[1:2] == [dest]:
                    return value
        raise AssertionError(f"no -v mount for {dest} in {self.calls}")


def _runtime(kind: str, tmp_path, fake: _FakeCli):
    state_dir = tmp_path / "reef-state"
    if kind == "docker":
        return DockerRuntime(docker_bin="docker", runner=fake, state_dir=str(state_dir)), state_dir
    rt = MicrosandboxRuntime(
        msb_bin="msb",
        runner=fake,
        state_dir=str(state_dir),
        volumes_dir=str(tmp_path / "msb-volumes"),
    )
    return rt, state_dir


def _spec() -> SandboxSpec:
    return SandboxSpec(
        sandbox_id="agent-1",
        image="reef-oc:test",
        env={"FOO": "bar"},
        volume="reef-agent-1",
        env_dest=GUEST_ENV_DIR,
        limits=Limits(cpus=2.0, memory_mb=2048),
    )


@pytest.mark.parametrize("kind", ["docker", "microsandbox"])
def test_env_mount_is_a_read_only_host_path_under_the_state_dir(kind, tmp_path):
    """Not the runtime's own volumes root: msb's lives under the service user's
    home, which install.sh leaves world-traversable 0755. And ``:ro``, or the
    agent could forge its own environment."""
    previous = os.umask(0o077)  # the modes are set explicitly; a tight umask must not win
    try:
        fake = _FakeCli()
        rt, state_dir = _runtime(kind, tmp_path, fake)
        asyncio.run(rt.create(_spec()))
    finally:
        os.umask(previous)

    source, dest, *options = fake.mount_for(GUEST_ENV_DIR).split(":")
    assert dest == GUEST_ENV_DIR
    assert options == ["ro"]
    assert Path(source).is_absolute()  # a host path, not a named volume
    assert Path(source) == state_dir / "env" / "agent-1"
    assert not Path(source).is_relative_to(tmp_path / "msb-volumes")

    # Created eagerly, so the mount source exists before the container does.
    assert stat.S_IMODE(Path(source).stat().st_mode) == 0o755
    assert stat.S_IMODE((state_dir / "env").stat().st_mode) == 0o700


@pytest.mark.parametrize("kind", ["docker", "microsandbox"])
def test_destroy_keeps_the_overlay_and_remove_guest_env_drops_the_whole_dir(kind, tmp_path):
    # An in-place upgrade recreates the container through this same ``destroy``,
    # so an env dir it could reach would lose the operator's vars every upgrade.
    previous = os.umask(0o077)
    try:
        fake = _FakeCli()
        rt, state_dir = _runtime(kind, tmp_path, fake)
        asyncio.run(rt.create(_spec()))
        records = [EnvRecord("s", "AGENTPIT_API_KEY", "sk-live-example")]
        asyncio.run(rt.write_guest_env("agent-1", records))
    finally:
        os.umask(previous)

    env_dir = state_dir / "env" / "agent-1"
    assert stat.S_IMODE((env_dir / ENV_FILENAME).stat().st_mode) == 0o644

    asyncio.run(rt.destroy("agent-1"))
    assert asyncio.run(rt.read_guest_env("agent-1")) == records

    asyncio.run(rt.remove_guest_env("agent-1"))
    assert asyncio.run(rt.read_guest_env("agent-1")) is None
    assert not env_dir.exists()
