from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..models import AnalysisEntry, Metadata
from ..scheduler import set_interval, trigger_analysis
from ..storage import StorageContext

router = APIRouter(prefix="/api/claude", tags=["claude"])


class IntervalUpdate(BaseModel):
    minutes: int = Field(ge=1, le=60)


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


@router.put("/interval")
def update_interval(body: IntervalUpdate) -> dict:
    set_interval(body.minutes)
    return {"minutes": body.minutes}


@router.get("/history")
def history() -> list[AnalysisEntry]:
    with StorageContext() as ctx:
        return ctx.metadata.history
