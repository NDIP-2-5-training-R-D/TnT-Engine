from fastapi import APIRouter, Depends, HTTPException, status

from app.api.dependencies import verify_vault_token
from app.adapters.db_adapter import get_db_adapter, DbAdapter
from app.adapters.crypto_adapter import get_crypto_adapter, CryptoAdapter
from app.models.requests import (
    RoleCreateRequest,
    TemplateCreateRequest,
    MaskingTransformRequest,
    FPETransformRequest,
    TokenizationTransformRequest,
    AlphabetCreateRequest,
    EncodeRequest,
    DecodeRequest,
)
from app.models.responses import GenericResponse, ListResponse

router = APIRouter(prefix="/v1/transform", dependencies=[Depends(verify_vault_token)])


# ── Role ─────────────────────────────────────────────────────────────────────

@router.post("/role/{role_name}", response_model=GenericResponse)
async def create_role(role_name: str, body: RoleCreateRequest, db: DbAdapter = Depends(get_db_adapter)):
    await db.save_role(role_name, body.model_dump())
    return GenericResponse(data={"role": role_name, **body.model_dump()})


@router.get("/role/{role_name}", response_model=GenericResponse)
async def get_role(role_name: str, db: DbAdapter = Depends(get_db_adapter)):
    data = await db.get_role(role_name)
    if data is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Role '{role_name}' not found")
    return GenericResponse(data=data)


@router.get("/role", response_model=ListResponse)
async def list_roles(db: DbAdapter = Depends(get_db_adapter)):
    keys = await db.list_roles()
    return ListResponse(keys=keys)


@router.delete("/role/{role_name}", response_model=GenericResponse)
async def delete_role(role_name: str, db: DbAdapter = Depends(get_db_adapter)):
    deleted = await db.delete_role(role_name)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Role '{role_name}' not found")
    return GenericResponse(data={"deleted": role_name})


# ── Template ──────────────────────────────────────────────────────────────────

@router.post("/template/{template_name}", response_model=GenericResponse)
async def create_template(template_name: str, body: TemplateCreateRequest, db: DbAdapter = Depends(get_db_adapter)):
    await db.save_template(template_name, body.model_dump())
    return GenericResponse(data={"template": template_name, **body.model_dump()})


@router.get("/template/{template_name}", response_model=GenericResponse)
async def get_template(template_name: str, db: DbAdapter = Depends(get_db_adapter)):
    data = await db.get_template(template_name)
    if data is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Template '{template_name}' not found")
    return GenericResponse(data=data)


@router.get("/template", response_model=ListResponse)
async def list_templates(db: DbAdapter = Depends(get_db_adapter)):
    keys = await db.list_templates()
    return ListResponse(keys=keys)


@router.delete("/template/{template_name}", response_model=GenericResponse)
async def delete_template(template_name: str, db: DbAdapter = Depends(get_db_adapter)):
    deleted = await db.delete_template(template_name)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Template '{template_name}' not found")
    return GenericResponse(data={"deleted": template_name})


# ── Transformations ───────────────────────────────────────────────────────────

@router.post("/transformations/masking/{name}", response_model=GenericResponse)
async def create_masking(name: str, body: MaskingTransformRequest, db: DbAdapter = Depends(get_db_adapter)):
    await db.save_transformation(name, body.model_dump())
    return GenericResponse(data={"name": name, **body.model_dump()})


@router.post("/transformations/fpe/{name}", response_model=GenericResponse)
async def create_fpe(name: str, body: FPETransformRequest, db: DbAdapter = Depends(get_db_adapter)):
    await db.save_transformation(name, body.model_dump())
    return GenericResponse(data={"name": name, **body.model_dump()})


@router.post("/transformations/tokenization/{name}", response_model=GenericResponse)
async def create_tokenization(name: str, body: TokenizationTransformRequest, db: DbAdapter = Depends(get_db_adapter)):
    await db.save_transformation(name, body.model_dump())
    return GenericResponse(data={"name": name, **body.model_dump()})


@router.get("/transformation/{name}", response_model=GenericResponse)
async def get_transformation(name: str, db: DbAdapter = Depends(get_db_adapter)):
    data = await db.get_transformation(name)
    if data is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Transformation '{name}' not found")
    return GenericResponse(data=data)


@router.get("/transformation", response_model=ListResponse)
async def list_transformations(db: DbAdapter = Depends(get_db_adapter)):
    keys = await db.list_transformations()
    return ListResponse(keys=keys)


@router.delete("/transformation/{name}", response_model=GenericResponse)
async def delete_transformation(name: str, db: DbAdapter = Depends(get_db_adapter)):
    deleted = await db.delete_transformation(name)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Transformation '{name}' not found")
    return GenericResponse(data={"deleted": name})


# ── Alphabet ──────────────────────────────────────────────────────────────────

@router.post("/alphabet/{alphabet_name}", response_model=GenericResponse)
async def create_alphabet(alphabet_name: str, body: AlphabetCreateRequest):
    # TODO: persist via db_adapter when DB is ready
    return GenericResponse(data={"name": alphabet_name, "alphabet": body.alphabet})


# ── Encode & Decode ───────────────────────────────────────────────────────────

@router.post("/encode/{role_name}", response_model=GenericResponse)
async def encode(role_name: str, body: EncodeRequest, crypto: CryptoAdapter = Depends(get_crypto_adapter)):
    result = await crypto.fpe_encrypt(body.transformation, body.value)
    return GenericResponse(data={"encoded_value": result})


@router.post("/decode/{role_name}", response_model=GenericResponse)
async def decode(role_name: str, body: DecodeRequest, crypto: CryptoAdapter = Depends(get_crypto_adapter)):
    result = await crypto.fpe_decrypt(body.transformation, body.value)
    return GenericResponse(data={"decoded_value": result})


# ── Key Management ────────────────────────────────────────────────────────────

@router.post("/transformations/fpe/{name}/rotate-key", response_model=GenericResponse)
async def fpe_rotate_key(name: str):
    # TODO: call OpenBao key rotation endpoint
    return GenericResponse(data={"message": f"Key rotation initiated for FPE '{name}' (mock)"})


@router.get("/transformations/fpe/{name}/keys", response_model=GenericResponse)
async def fpe_list_keys(name: str):
    # TODO: call OpenBao list keys endpoint
    return GenericResponse(data={"keys": {"1": {"creation_time": "mock"}}, "latest_version": 1})


@router.post("/transformations/tokenization/{name}/rotate-key", response_model=GenericResponse)
async def tokenization_rotate_key(name: str):
    # TODO: call OpenBao key rotation endpoint
    return GenericResponse(data={"message": f"Key rotation initiated for tokenization '{name}' (mock)"})


@router.get("/transformations/tokenization/{name}/keys", response_model=GenericResponse)
async def tokenization_list_keys(name: str):
    # TODO: call OpenBao list keys endpoint
    return GenericResponse(data={"keys": {"1": {"creation_time": "mock"}}, "latest_version": 1})
