import unicodedata
from collections import defaultdict

from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.ext.asyncio import AsyncSession

from lexicona.infrastructure.models import Tag, WordTag, new_id


class TagOut(BaseModel):
    id: str
    name: str


def tag_name(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).split())


def tag_key(value: str) -> str:
    return value.casefold()


async def replace_tags(db: AsyncSession, owner_id: str, word_id: str, names: list[str]) -> None:
    for name in names:
        await db.execute(
            insert(Tag)
            .values(id=new_id(), owner_id=owner_id, name=name, normalized_name=tag_key(name))
            .on_conflict_do_nothing(index_elements=[Tag.owner_id, Tag.normalized_name])
        )
    keys = [tag_key(name) for name in names]
    tags = (
        await db.scalars(select(Tag).where(Tag.owner_id == owner_id, Tag.normalized_name.in_(keys)))
    ).all()
    await db.execute(
        delete(WordTag).where(WordTag.owner_id == owner_id, WordTag.word_id == word_id)
    )
    db.add_all([WordTag(owner_id=owner_id, word_id=word_id, tag_id=tag.id) for tag in tags])


async def tags_for_words(
    db: AsyncSession, owner_id: str, word_ids: list[str]
) -> dict[str, list[TagOut]]:
    result: dict[str, list[TagOut]] = defaultdict(list)
    rows = await db.execute(
        select(WordTag.word_id, Tag.id, Tag.name)
        .join(Tag, (Tag.id == WordTag.tag_id) & (Tag.owner_id == WordTag.owner_id))
        .where(
            WordTag.owner_id == owner_id, Tag.owner_id == owner_id, WordTag.word_id.in_(word_ids)
        )
        .order_by(Tag.normalized_name, Tag.id)
    )
    for word_id, tag_id, name in rows:
        result[word_id].append(TagOut(id=tag_id, name=name))
    return result
