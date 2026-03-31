from pydantic import BaseModel, Field
from typing import Optional


# ---------- Transit ----------

class EncryptRequest(BaseModel):
    plaintext: str = Field(..., description="Plain text to encrypt (will be base64-encoded automatically)")
    key_name: str = Field(default="ndip-key", description="Transit key name")


class EncryptResponse(BaseModel):
    ciphertext: str


class DecryptRequest(BaseModel):
    ciphertext: str = Field(..., description="Ciphertext returned by encrypt")
    key_name: str = Field(default="ndip-key")


class DecryptResponse(BaseModel):
    plaintext: str


# ---------- Transform ----------

class TokenizeRequest(BaseModel):
    value: str = Field(..., description="Phone number (10 digits) to tokenize")
    role: str = Field(default="ndip-role")
    transformation: str = Field(default="phone-fpe")


class TokenizeResponse(BaseModel):
    encoded_value: str


class DetokenizeRequest(BaseModel):
    value: str = Field(..., description="Tokenized value to decode")
    role: str = Field(default="ndip-role")
    transformation: str = Field(default="phone-fpe")


class DetokenizeResponse(BaseModel):
    decoded_value: str
