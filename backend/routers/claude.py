from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..claude_analyzer import list_all_sessions
from ..models import AnalysisEntry, Metadata
from ..scheduler import set_interval, trigger_analysis
from ..storage import StorageContext

router = APIRouter(prefix="/api/claude", tags=["claude"])


class IntervalUpdate(BaseModel):
    minutes: int = Field(ge=1, le=60)


class WakeRequest(BaseModel):
    model: Optional[str] = None
    force: bool = False
    session_keys: Optional[List[str]] = None


class ModelUpdate(BaseModel):
    model: str


@router.post("/wake")
async def wake(body: WakeRequest = WakeRequest()) -> dict:
    return await trigger_analysis(
        model=body.model, force=body.force, session_keys=body.session_keys,
    )


@router.get("/sessions")
def sessions() -> list[dict]:
    return list_all_sessions()


@router.put("/model")
def update_model(body: ModelUpdate) -> dict:
    with StorageContext() as ctx:
        ctx.metadata.analysis_model = body.model
    return {"model": body.model}


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


@router.put("/insights/{insight_id}/dismiss")
def dismiss_insight(insight_id: str) -> dict:
    with StorageContext() as ctx:
        for insight in ctx.metadata.insights:
            if insight.id == insight_id:
                insight.dismissed = True
                return {"status": "ok"}
    raise HTTPException(status_code=404, detail="Insight not found")
