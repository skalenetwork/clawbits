from eth_account.signers.local import LocalAccount
from pydantic import BaseModel, ConfigDict

from clawbits.datastructures.agent_id import AgentId
from clawbits.datastructures.sha256_hash import SHA256Hash


class Agent(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    agent_id: AgentId
    eth_key: LocalAccount
    api_key_hash: SHA256Hash
