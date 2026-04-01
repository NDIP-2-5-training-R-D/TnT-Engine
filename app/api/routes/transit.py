from fastapi import APIRouter, Depends

from app.api.dependencies import verify_vault_token
from app.adapters.crypto_adapter import get_crypto_adapter, CryptoAdapter
from app.models.requests import (
    TransitKeyCreateRequest,
    TransitEncryptRequest,
    TransitDecryptRequest,
    TransitSignRequest,
    TransitVerifyRequest,
)
from app.models.responses import (
    GenericResponse,
    TransitEncryptResponse,
    TransitDecryptResponse,
    TransitSignResponse,
    TransitVerifyResponse,
)

router = APIRouter(prefix="/v1/transit", dependencies=[Depends(verify_vault_token)])


@router.post("/keys/{key_name}", response_model=GenericResponse)
async def create_key(key_name: str, body: TransitKeyCreateRequest):
    # TODO: call OpenBao /v1/transit/keys/{key_name}
    return GenericResponse(data={"key_name": key_name, "type": body.type, "status": "created (mock)"})


@router.post("/encrypt/{key_name}", response_model=TransitEncryptResponse)
async def encrypt(key_name: str, body: TransitEncryptRequest, crypto: CryptoAdapter = Depends(get_crypto_adapter)):
    ciphertext = await crypto.transit_encrypt(key_name, body.plaintext)
    return TransitEncryptResponse(ciphertext=ciphertext)


@router.post("/decrypt/{key_name}", response_model=TransitDecryptResponse)
async def decrypt(key_name: str, body: TransitDecryptRequest, crypto: CryptoAdapter = Depends(get_crypto_adapter)):
    plaintext = await crypto.transit_decrypt(key_name, body.ciphertext)
    return TransitDecryptResponse(plaintext=plaintext)


@router.post("/sign/{key_name}", response_model=TransitSignResponse)
async def sign(key_name: str, body: TransitSignRequest, crypto: CryptoAdapter = Depends(get_crypto_adapter)):
    signature = await crypto.transit_sign(key_name, body.input)
    return TransitSignResponse(signature=signature)


@router.post("/verify/{key_name}", response_model=TransitVerifyResponse)
async def verify(key_name: str, body: TransitVerifyRequest, crypto: CryptoAdapter = Depends(get_crypto_adapter)):
    valid = await crypto.transit_verify(key_name, body.input, body.signature)
    return TransitVerifyResponse(valid=valid)
