from fastapi import APIRouter
from sqlalchemy import select

from lexicona.deps import CurrentAuth, Db
from lexicona.models import Tag
from lexicona.tags import TagOut

router = APIRouter(prefix="/tags", tags=["tags"])


@router.get("")
async def list_tags(auth: CurrentAuth, db: Db) -> list[TagOut]:
    tags = await db.scalars(
        select(Tag).where(Tag.owner_id == auth.user.id).order_by(Tag.normalized_name, Tag.id)
    )
    return [TagOut(id=tag.id, name=tag.name) for tag in tags]
