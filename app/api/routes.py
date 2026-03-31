from fastapi import APIRouter, HTTPException
from app.engine.openbao_client import bao_client
from app.engine.fpe_tokenizer import tokenize_phone, detokenize_phone
from app.models.schemas import (
    EncryptRequest, EncryptResponse,
    DecryptRequest, DecryptResponse,
    TokenizeRequest, TokenizeResponse,
    DetokenizeRequest, DetokenizeResponse,
)

router = APIRouter()


# ---------- Transit (OpenBao) ----------

@router.post("/transit/encrypt", response_model=EncryptResponse, tags=["Transit"])
async def transit_encrypt(req: EncryptRequest):
    try:
        ciphertext = await bao_client.encrypt(req.key_name, req.plaintext)
        return EncryptResponse(ciphertext=ciphertext)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/transit/decrypt", response_model=DecryptResponse, tags=["Transit"])
async def transit_decrypt(req: DecryptRequest):
    try:
        plaintext = await bao_client.decrypt(req.key_name, req.ciphertext)
        return DecryptResponse(plaintext=plaintext)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------- Transform / FPE (Python ff3) ----------

@router.post("/transform/tokenize", response_model=TokenizeResponse, tags=["Transform"])
async def transform_tokenize(req: TokenizeRequest):
    try:
        encoded = tokenize_phone(req.value)
        return TokenizeResponse(encoded_value=encoded)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/transform/detokenize", response_model=DetokenizeResponse, tags=["Transform"])
async def transform_detokenize(req: DetokenizeRequest):
    try:
        decoded = detokenize_phone(req.value)
        return DetokenizeResponse(decoded_value=decoded)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
