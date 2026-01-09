#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${CYAN}=== Starting Sunchron Dev Environment ===${NC}"

# 1. Setup/Start Python Logic Core
echo -e "${GREEN}>> Starting Logic Core Service (Python)...${NC}"
cd services/logic-core

if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

source venv/bin/activate
pip install -r requirements.txt > /dev/null 2>&1
echo "Python dependencies installed."

# Run Uvicorn in background
uvicorn main:app --host 0.0.0.0 --port 8000 &
LOGIC_PID=$!
echo "Logic Core running (PID: $LOGIC_PID)"

cd ../..

# 2. Start Node.js Backend
echo -e "${GREEN}>> Starting Node.js Backend...${NC}"

# Function to kill logic core when node stops
cleanup() {
    echo -e "${CYAN}Stopping Logic Core...${NC}"
    kill $LOGIC_PID
    exit
}

trap cleanup SIGINT SIGTERM

npm start
