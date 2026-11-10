from fastapi import APIRouter
from sqlalchemy import select

from lexicona.application.tags import TagOut
from lexicona.infrastructure.models import Tag
from lexicona.interfaces.http.deps import CurrentAuth, Db

router = APIRouter(prefix="/tags", tags=["tags"])


@router.get("")
async def list_tags(auth: CurrentAuth, db: Db) -> list[TagOut]:
    tags = await db.scalars(
        select(Tag).where(Tag.owner_id == auth.user.id).order_by(Tag.normalized_name, Tag.id)
    )
    return [TagOut(id=tag.id, name=tag.name) for tag in tags]
