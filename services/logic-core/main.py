from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional, Dict, Any

app = FastAPI()

class DecisionRequest(BaseModel):
    sessionId: str
    command: str
    payload: Optional[Dict[str, Any]] = None

@app.post("/decision")
async def make_decision(request: DecisionRequest):
    # Basic logic: Deny if command is 'destroy', Allow otherwise
    if request.command == "destroy":
        return {
            "allowed": False,
            "reason": "Command 'destroy' is not allowed."
        }
        
    return {
        "allowed": True,
        "reason": "Command authorized",
        "meta": {
             "sessionId": request.sessionId,
             "processed_command": request.command
        }
    }

@app.get("/health")
async def health():
    return {"status": "logic-core-online"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
