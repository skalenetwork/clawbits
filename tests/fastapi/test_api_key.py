import pytest

from clawbits.datastructures.api_key import ApiKey


def test_api_key_valid():
    """Test creating valid ApiKey instances."""
    # Standard format: fc_ + 16 alphanumeric
    api_key = ApiKey("fc_1234567890abcdef")
    assert api_key.value == "fc_1234567890abcdef"
    assert str(api_key) == "fc_1234567890abcdef"

    # Lowercase only
    api_key2 = ApiKey("fc_abcdefghijklmnop")
    assert api_key2.value == "fc_abcdefghijklmnop"

    # Uppercase only
    api_key3 = ApiKey("fc_ABCDEFGHIJKLMNOP")
    assert api_key3.value == "fc_ABCDEFGHIJKLMNOP"

    # Mixed case
    api_key4 = ApiKey("fc_AbCdEfGhIjKlMnOp")
    assert api_key4.value == "fc_AbCdEfGhIjKlMnOp"

    # Numbers only
    api_key5 = ApiKey("fc_1234567890123456")
    assert api_key5.value == "fc_1234567890123456"

    # Mixed alphanumeric
    api_key6 = ApiKey("fc_aB1cD2eF3gH4iJ5k")
    assert api_key6.value == "fc_aB1cD2eF3gH4iJ5k"


def test_api_key_generate():
    """Test generating random API keys."""
    # Generate multiple keys and check they're valid and unique
    keys = set()
    for _ in range(10):
        api_key = ApiKey.generate()
        assert api_key.value.startswith("fc_")
        assert len(api_key.value) == 19  # fc_ (3) + 16 chars
        assert api_key.value not in keys  # Should be unique
        keys.add(api_key.value)


def test_api_key_invalid_empty():
    """Test that empty ApiKey is rejected."""
    with pytest.raises(Exception) as exc_info:
        ApiKey("")
    assert "must not be empty" in str(exc_info.value)


def test_api_key_invalid_format():
    """Test that ApiKey with invalid format is rejected."""
    # Too short
    with pytest.raises(Exception) as exc_info:
        ApiKey("fc_123")
    assert "exactly 16 alphanumeric characters" in str(exc_info.value)

    # Too long
    with pytest.raises(Exception) as exc_info:
        ApiKey("fc_12345678901234567")
    assert "exactly 16 alphanumeric characters" in str(exc_info.value)

    # Missing prefix
    with pytest.raises(Exception) as exc_info:
        ApiKey("1234567890abcdef")
    assert "must start with 'fc_'" in str(exc_info.value)

    # Wrong prefix
    with pytest.raises(Exception) as exc_info:
        ApiKey("xx_1234567890abcdef")
    assert "must start with 'fc_'" in str(exc_info.value)

    # Invalid characters (special chars)
    with pytest.raises(Exception) as exc_info:
        ApiKey("fc_1234567890abcd@!")
    assert "exactly 16 alphanumeric characters" in str(exc_info.value)

    # Invalid characters (spaces)
    with pytest.raises(Exception) as exc_info:
        ApiKey("fc_1234567890abcd ")
    assert "exactly 16 alphanumeric characters" in str(exc_info.value)

    # Just prefix
    with pytest.raises(Exception) as exc_info:
        ApiKey("fc_")
    assert "exactly 16 alphanumeric characters" in str(exc_info.value)


def test_api_key_repr():
    """Test string representation of ApiKey."""
    api_key = ApiKey("fc_1234567890abcdef")
    assert str(api_key) == "fc_1234567890abcdef"
    assert repr(api_key) == "ApiKey('fc_1234567890abcdef')"


def test_api_key_equality():
    """Test that ApiKey instances with same value are equal."""
    api_key1 = ApiKey("fc_1234567890abcdef")
    api_key2 = ApiKey("fc_1234567890abcdef")
    api_key3 = ApiKey("fc_ABCDEF1234567890")

    assert api_key1 == api_key2
    assert api_key1 != api_key3


def test_api_key_with_pydantic():
    """Test ApiKey works with Pydantic models."""
    from pydantic import BaseModel

    class TestModel(BaseModel):
        api_key: ApiKey

    # From string
    model = TestModel(api_key="fc_1234567890abcdef")
    assert isinstance(model.api_key, ApiKey)
    assert model.api_key.value == "fc_1234567890abcdef"

    # Serialization
    data = model.model_dump()
    assert data["api_key"] == "fc_1234567890abcdef"

    # From ApiKey object
    api_key = ApiKey("fc_ABCDEF1234567890")
    model2 = TestModel(api_key=api_key)
    assert model2.api_key.value == "fc_ABCDEF1234567890"

