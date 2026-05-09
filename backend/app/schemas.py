"""Pydantic request/response models (API contracts)."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class UserRead(BaseModel):
    """Public user profile returned by /auth/me and member lists."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    osu_id: int
    username: str
    avatar_url: str
    created_at: datetime
    updated_at: datetime
