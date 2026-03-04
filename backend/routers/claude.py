from fastapi import APIRouter

from ..models import AnalysisEntry, Metadata
from ..scheduler import trigger_analysis
from ..storage import StorageContext

router = APIRouter(prefix="/api/claude", tags=["claude"])


@router.post("/wake")
async def wake() -> dict:
    return await trigger_analysis()


@router.get("/status")
def status() -> dict:
    with StorageContext() as ctx:
        return {
            "scheduler_status": ctx.metadata.scheduler_status,
            "heartbeat": ctx.metadata.heartbeat,
            "last_analysis": ctx.metadata.last_analysis.model_dump() if ctx.metadata.last_analysis else None,
        }


@router.get("/history")
def history() -> list[AnalysisEntry]:
    with StorageContext() as ctx:
        return ctx.metadata.history
