from fastapi import FastAPI
from app.api.routes import router

app = FastAPI(
    title="NDIP T&T Engine",
    description="Tokenization & Transform service backed by OpenBao",
    version="0.1.0",
)

app.include_router(router, prefix="/api/v1")


@app.get("/health", tags=["Health"])
async def health():
    return {"status": "ok"}
