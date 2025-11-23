import time
from typing import Optional, List
from fastapi import (
    FastAPI,
    Request,
    Query
)
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger

from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ai_engine.config import COLLECTION_NAME, SEARCH_LIMIT, SQL_DB_NAME
from ai_engine.db_interface import DB_Interface
from ai_engine.search import GlobalSearch
from ai_engine.projection_builder import ProjectionBuilder
from ai_engine.narrative import NarrativeGenerator
from ai_engine.common import Event, User

app = FastAPI(
    title="AI-Engine API"
)
app.mount("/static", StaticFiles(directory="static"), name="static")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Logging & Timing Middleware
@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Logs the time taken, status code, IP, and path for every request."""
    start_time = time.time()
    
    # Process Request (before endpoint runs)
    try:
        response = await call_next(request)
    except Exception as e:
        # Catch exceptions thrown by the app logic
        logger.error(f"Request failed: {request.url.path} - {e}")
        raise

    # Process Response (after endpoint runs)
    process_time = time.time() - start_time
    status_code = response.status_code
    
    logger.info(
        # f"Request: {request.method} {request.url.path} | "
        # f"Status: {status_code} | "
        f"Time: {process_time:.4f}s | "
        f"IP: {request.client.host} | "
        f"UA: {request.headers.get('user-agent', 'N/A')}"
    )

    return response

### UI
#########################

@app.get("/demo", tags=["Health"], include_in_schema=False)
def demo():
    return FileResponse("static/intent.html")

@app.get("/demo/app", tags=["Health"], include_in_schema=False)
def demo_app():
    return FileResponse("static/index.html")

@app.get("/demo/newQuiz", tags=["Health"], include_in_schema=False)
def demo_quiz():
    return FileResponse("static/newQuiz.html")

@app.get("/demo/newQuiz/myResults", tags=["Health"], include_in_schema=False)
def demo_quiz_results():
    return FileResponse("static/newQuizResults.html")

### Routes
#########################

### / Health Check
@app.get("/", tags=["Health"])
def root():
    return {
        "status": "ok",
        "message": "AI Engine Service is running."
    }

### / Search
searcher = GlobalSearch(collection_name=COLLECTION_NAME)

@app.get("/api/search", tags=["Search"])
async def read_item_search(q: str = Query(..., description="Search text", example="Bergen-Belsen")):
    results = searcher.search(text=q)
    return {
        "result": results
    }

@app.get("/api/search/geo", tags=["Search"])
async def read_geo_search(
    lat: float = Query(..., example=52.7579),
    lon: float = Query(..., example=9.9048),
    radius_meters: float = Query(5000),
    q: Optional[str] = Query(
        default=None,
        description="Search text (optional)",
        example="Bergen-Belsen",
    ),
):
    results = searcher.search(
            text=q,
            lat=lat,
            lon=lon,
            radius_meters=radius_meters
        )
    return {
        "result": results.dict()
    }

@app.get("/api/search/preference", tags=["Search"])
async def read_event_search(
    user_id: int = Query(..., example=10),
    # lat: Optional[float] = Query(default=None, example=52.7579),
    # lon: Optional[float] = Query(default=None, example=9.9048),
    # radius_meters: float = Query(5000),
):
    """
    Search by user history and optionally by location.
    """
    user_recommender = searcher.user_recommender
    results = user_recommender.recommend_for_user(user_id=user_id)
    return {
        "result": results.dict()
    }
    # Get user state / history
    # Extract positive negative signals
    # Query qdrant on semantic taste vector
    # Rerank on engagement
    # Apply MMR for diversity

@app.get("/api/search/profile", tags=["Search"])
async def read_user_search(
    user_id: int = Query(..., example=10),
    # lat: Optional[float] = Query(default=None, example=52.7579),
    # lon: Optional[float] = Query(default=None, example=9.9048),
    # radius_meters: float = Query(5000),
):
    """
    Search by user history and optionally by location.
    """
    db_projection = ProjectionBuilder(collection_name=COLLECTION_NAME)
    user_query = db_projection.get_user_profile_as_text(user_id = user_id)
    results = searcher.search(text=user_query)
    return {
        "result": results.dict()
    }
    # Get user state / history
    # Extract positive negative signals
    # Query qdrant on semantic taste vector
    # Rerank on engagement
    # Apply MMR for diversity

### / Narrative
class NarrativeRequest(BaseModel):
    items: List[dict]

@app.post("/api/narrative", tags=['Show'])
async def create_narrative(request: NarrativeRequest):
    """
    Turn a set of items into a narrative
    """
    narrative_generator = NarrativeGenerator()
    narrative = narrative_generator.generate_narrative(request.items)
    return {
        "result": narrative
    }

### / Debug
@app.get("/debug/user_info", tags=["Debug"])
async def read_user(user_id: int = Query(..., example=10)):
    db_client = DB_Interface()
    db_projection = ProjectionBuilder(collection_name=COLLECTION_NAME)
    user_data = db_client.fetch_user(user_id=int(user_id))
    user_history = db_client.fetch_events_raw(user_id=int(user_id))
    user_dwell = db_client.fetch_events(user_id=int(user_id))
    user_metrics = db_projection.get_user_projection(user_id=int(user_id))
    return {
        "result": {
            "user_data": user_data.to_dict(orient="records"),
            "user_history": user_history.to_dict(orient="records"),
            "user_dwell": user_dwell.to_dict(orient="records"),
            "user_metrics": user_metrics.to_dict(orient="records"),
        }
    }

@app.get("/debug/item_info", tags=["Debug"])
async def read_item(item_id: List[int] = Query(..., example="2148")):
    item = searcher.common_searcher.get_item(item_id=item_id)
    logger.info(f"Fetched item: {item}")
    return {
        "result": item,
    }

### / DB
@app.post("/db/guest", tags=["Insert"])
async def create_guest():
    """
    Generates an unidentified session and user
    """
    return {
        "status": "not implemented", 
    }

@app.post("/db/user", tags=["Insert"])
async def create_user(user: User):
    """
    Inserts a user row via DB_Interface.register_user.
    """
    db_client = DB_Interface()
    result = db_client.register_user(user)
    if result['status'] == "failed":
        return {"status": "error", "id": None}
    return {
        "status": "ok", 
        "id": result['id'], 
        "license_plate": result['license_plate']
    }

@app.post("/db/events", tags=["Insert"])
async def create_event(event: Event):
    """
    Dumb endpoint: inserts an event row via DB_Interface.register_event.
    """
    db_client = DB_Interface()
    result = db_client.register_event(event)
    if result['status'] == "failed":
        return {"status": "error", "id": None}
    return {
        "status": "ok", 
        "id": result['id'], 
    }

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("service:app", host="0.0.0.0", port=8000, reload=True)
