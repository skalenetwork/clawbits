import json
from pathlib import Path

import pytest

# torch ships only in the optional `lobstertalk` extra
# (`uv sync --extra lobstertalk`). Skip rather than error so a bare
# `pytest` works for contributors who did not install it.
pytest.importorskip("torch", reason="requires the lobstertalk extra")

import torch  # noqa: E402

from clawbits.lobstertalk.train_student import (
    extract_features,
    iter_examples_from_corpus,
    murmurhash3_x86_32,
)


def test_murmurhash3_is_uint32():
    h = murmurhash3_x86_32("hello")
    assert 0 <= h <= 0xFFFFFFFF


def test_extract_features_layout_null_state():
    x = extract_features(
        message="Hello @Alice",
        sender="Alice",
        prev_sender=None,
        dt_seconds=None,
        active_users=["Alice", "Bob"],
    )
    assert x.shape == (64,)
    assert x.dtype == torch.float32

    # sender one-hot
    assert x[0].item() == 1.0

    # prev sender all zeros when null-state
    assert x[8:16].sum().item() == 0.0

    # dt null-state => 1.0
    assert x[16].item() == 1.0

    # mention flag
    assert x[50].item() == 1.0


def test_iter_examples_from_corpus_smoke(tmp_path: Path):
    corpus = [
        {
            "thread_id": "t1",
            "persona_map": {"Alice": "Engineering", "Bob": "Engineering"},
            "messages": [
                {
                    "msg_id": "m1",
                    "sender": "Alice",
                    "text": "ping @Bob about api",
                    "timestamp_offset": 0,
                    "metadata": {"reasoning": "", "target_probs": {"Bob": 1.0}},
                },
                {
                    "msg_id": "m2",
                    "sender": "Bob",
                    "text": "ok",
                    "timestamp_offset": 10,
                    "metadata": {"reasoning": "", "target_probs": {"global": 1.0}},
                },
            ],
        }
    ]

    examples = iter_examples_from_corpus(corpus)
    assert len(examples) == 2
    assert examples[0].x.shape == (64,)
    assert examples[0].y.shape == (10,)

    # Teacher probs should be normalized
    assert torch.isclose(examples[0].y.sum(), torch.tensor(1.0), atol=1e-4)


@pytest.mark.parametrize("epochs", [1])
def test_train_script_importable_and_forward(epochs: int, tmp_path: Path):
    # Smoke-check that a tiny dataset can be turned into tensors and run through the model.
    corpus_path = tmp_path / "corpus.json"
    corpus = [
        {
            "thread_id": "t1",
            "persona_map": {"Alice": "Engineering", "Bob": "Engineering"},
            "messages": [
                {
                    "msg_id": "m1",
                    "sender": "Alice",
                    "text": "hey",
                    "timestamp_offset": 0,
                    "metadata": {"reasoning": "", "target_probs": {"global": 1.0}},
                }
            ],
        }
    ]
    corpus_path.write_text(json.dumps(corpus), encoding="utf-8")

    from clawbits.lobstertalk.train_student import train_student

    model = train_student(
        corpus_path=corpus_path,
        epochs=epochs,
        batch_size=1,
        lr=1e-3,
        device="cpu",
        max_examples=10,
    )

    with torch.no_grad():
        out = model(torch.zeros(1, 64))
    assert out.shape == (1, 10)

