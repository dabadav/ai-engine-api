# security.py
import secrets
import hashlib
import datetime

def generate_token(length: int = 32) -> str:
    # URL-safe, random token (256 bits)
    return secrets.token_urlsafe(length)

def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()

# dependencies.py
# from fastapi import Depends, Request, Response, HTTPException, status
# from ai_engine.db_interface import get_session_by_hash, get_user_by_id

# async def get_current_session(request: Request):
#     raw_token = request.cookies.get("sid")
#     if not raw_token:
#         return None  # anonymous

#     token_hash = hash_token(raw_token)
#     session = await get_session_by_hash(token_hash)
#     if not session or session.is_revoked or session.expires_at < datetime.utcnow():
#         raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid session")

#     return session

# async def get_current_user(session = Depends(get_current_session)):
#     if session is None or session.user_id is None:
#         raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

#     user = await get_user_by_id(session.user_id)
#     if not user:
#         raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

#     return user

# async def ensure_device_id(request: Request, response: Response):
#     device_id = request.cookies.get("device_id")
#     if device_id:
#         return device_id

#     # create new device_id
#     device_id = generate_token()
#     # optionally insert into devices table (hash_token(device_id) etc.)

#     response.set_cookie(
#         key="device_id",
#         value=device_id,
#         httponly=False,      # usually you *can* let JS read this
#         secure=True,
#         samesite="lax",
#         path="/",
#         max_age=365*24*3600, # 1 year
#     )
#     return device_id

