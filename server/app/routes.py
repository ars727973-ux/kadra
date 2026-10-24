"""HTTP API: авторизация, проекты, ассеты."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .config import get_settings
from .db import get_db
from .models import Asset, Project, User, utcnow
from .schemas import AssetOut, Credentials, ProjectIn, ProjectOut, ProjectSummary, TokenOut, UserOut
from .security import create_token, current_user, hash_password, verify_password

router = APIRouter(prefix="/api")
CHUNK = 1024 * 1024
MAX_PROJECT_JSON = 20 * 1024 * 1024  # JSON проекта — не медиа, 20 МБ более чем достаточно


# ---------------------------------------------------------------- auth

@router.post("/auth/register", response_model=TokenOut, status_code=201, tags=["auth"])
def register(body: Credentials, db: Session = Depends(get_db)):
    if not get_settings().allow_registration:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Регистрация отключена администратором сервера")
    user = User(username=body.username.lower(), password_hash=hash_password(body.password))
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "Пользователь с таким именем уже существует")
    return TokenOut(access_token=create_token(user), username=user.username)


@router.post("/auth/login", response_model=TokenOut, tags=["auth"])
def login(body: Credentials, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.username == body.username.lower()))
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Неверный логин или пароль")
    return TokenOut(access_token=create_token(user), username=user.username)


@router.get("/auth/me", response_model=UserOut, tags=["auth"])
def me(user: User = Depends(current_user)):
    return UserOut(id=user.id, username=user.username, created_at=user.created_at)


# ---------------------------------------------------------------- projects

def _summary(p: Project) -> dict:
    return {"id": p.client_id, "name": p.name, "size": p.size, "created_at": p.created_at, "updated_at": p.updated_at}


@router.get("/projects", response_model=list[ProjectSummary], tags=["projects"])
def list_projects(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(Project).where(Project.owner_id == user.id).order_by(Project.updated_at.desc())).all()
    return [_summary(p) for p in rows]


@router.get("/projects/{project_id}", response_model=ProjectOut, tags=["projects"])
def get_project(project_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = db.scalar(select(Project).where(Project.owner_id == user.id, Project.client_id == project_id))
    if not p:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Проект не найден")
    return {**_summary(p), "data": json.loads(p.data)}


@router.put("/projects/{project_id}", response_model=ProjectSummary, tags=["projects"])
def put_project(project_id: str, body: ProjectIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if len(project_id) > 64:
        raise HTTPException(422, "Слишком длинный id проекта")
    if body.data.get("format") != "kadra-project":
        raise HTTPException(422, "Ожидается проект Kadra (format = kadra-project)")
    text = json.dumps(body.data, ensure_ascii=False, separators=(",", ":"))
    if len(text) > MAX_PROJECT_JSON:
        raise HTTPException(413, "JSON проекта слишком большой")
    p = db.scalar(select(Project).where(Project.owner_id == user.id, Project.client_id == project_id))
    if p is None:
        p = Project(owner_id=user.id, client_id=project_id, name=body.name, data=text, size=len(text))
        db.add(p)
    else:
        p.name = body.name
        p.data = text
        p.size = len(text)
        p.updated_at = utcnow()
    db.commit()
    db.refresh(p)
    return _summary(p)


@router.delete("/projects/{project_id}", status_code=204, tags=["projects"])
def delete_project(project_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    p = db.scalar(select(Project).where(Project.owner_id == user.id, Project.client_id == project_id))
    if not p:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Проект не найден")
    db.delete(p)
    db.commit()
    return Response(status_code=204)


# ---------------------------------------------------------------- assets

def _asset_out(a: Asset) -> dict:
    return {"id": a.id, "sha256": a.sha256, "filename": a.filename, "mime": a.mime, "size": a.size, "created_at": a.created_at}


@router.get("/assets", response_model=list[AssetOut], tags=["assets"])
def list_assets(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(Asset).where(Asset.owner_id == user.id).order_by(Asset.created_at.desc())).all()
    return [_asset_out(a) for a in rows]


@router.get("/assets/lookup", response_model=AssetOut, tags=["assets"])
def lookup_asset(sha256: str = Query(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$"), user: User = Depends(current_user), db: Session = Depends(get_db)):
    a = db.scalar(select(Asset).where(Asset.owner_id == user.id, Asset.sha256 == sha256))
    if not a:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ассет не найден")
    return _asset_out(a)


@router.post("/assets", response_model=AssetOut, status_code=201, tags=["assets"])
async def upload_asset(file: UploadFile = File(...), user: User = Depends(current_user), db: Session = Depends(get_db)):
    s = get_settings()
    tmp_dir = s.storage_dir / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = tmp_dir / f"{uuid.uuid4()}.part"
    sha = hashlib.sha256()
    size = 0
    try:
        with tmp_path.open("wb") as out:
            while chunk := await file.read(CHUNK):
                size += len(chunk)
                if size > s.max_upload_bytes:
                    raise HTTPException(413, f"Файл больше {s.max_upload_mb} МБ")
                sha.update(chunk)
                out.write(chunk)
        digest = sha.hexdigest()
        existing = db.scalar(select(Asset).where(Asset.owner_id == user.id, Asset.sha256 == digest))
        if existing:
            return _asset_out(existing)
        dest = s.storage_dir / str(user.id) / digest[:2] / digest
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(tmp_path), dest)
        a = Asset(owner_id=user.id, sha256=digest, filename=Path(file.filename or "file").name[:255], mime=(file.content_type or "application/octet-stream")[:128], size=size, path=str(dest.relative_to(s.storage_dir)))
        db.add(a)
        db.commit()
        db.refresh(a)
        return _asset_out(a)
    finally:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        await file.close()


def _owned_asset(asset_id: str, user: User, db: Session) -> Asset:
    a = db.get(Asset, asset_id)
    if not a or a.owner_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Ассет не найден")
    return a


@router.get("/assets/{asset_id}", tags=["assets"])
def download_asset(asset_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    a = _owned_asset(asset_id, user, db)
    path = get_settings().storage_dir / a.path
    if not path.exists():
        raise HTTPException(status.HTTP_410_GONE, "Файл ассета отсутствует в хранилище")
    # FileResponse поддерживает Range-запросы (докачка, перемотка)
    return FileResponse(path, media_type=a.mime, filename=a.filename)


@router.delete("/assets/{asset_id}", status_code=204, tags=["assets"])
def delete_asset(asset_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    a = _owned_asset(asset_id, user, db)
    path = get_settings().storage_dir / a.path
    db.delete(a)
    db.commit()
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
    return Response(status_code=204)
