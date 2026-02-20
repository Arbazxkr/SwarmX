#!/bin/bash
# SwarmX Install Script
# Usage: curl -fsSL https://raw.githubusercontent.com/Arbazxkr/SwarmX/main/install.sh | bash

set -e

REPO="Arbazxkr/SwarmX"
INSTALL_DIR="${SWARMX_HOME:-$HOME/.swarmx}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "  ${CYAN}⚛${NC}  ${BOLD}SwarmX${NC} Installer"
echo -e "  ${DIM}Multi-Agent Orchestration Framework${NC}"
echo -e "  ${DIM}──────────────────────────────────${NC}"
echo ""

# Check prerequisites
check_command() {
  if ! command -v "$1" &> /dev/null; then
    echo -e "  ${RED}✗${NC} $1 is required but not installed."
    exit 1
  fi
}

check_command "node"
check_command "npm"
check_command "git"

NODE_VERSION=$(node -v | cut -d 'v' -f 2 | cut -d '.' -f 1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo -e "  ${RED}✗${NC} Node.js 20+ required (found v$(node -v))"
  exit 1
fi

echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"
echo -e "  ${GREEN}✓${NC} npm $(npm -v)"
echo ""

# Clone or update
if [ -d "$INSTALL_DIR" ]; then
  echo -e "  ${DIM}Updating existing installation...${NC}"
  cd "$INSTALL_DIR"
  git pull --quiet
else
  echo -e "  ${DIM}Installing to $INSTALL_DIR${NC}"
  git clone --depth 1 "https://github.com/$REPO.git" "$INSTALL_DIR" --quiet
  cd "$INSTALL_DIR"
fi

# Install dependencies
echo -e "  ${DIM}Installing dependencies...${NC}"
npm install --silent 2>/dev/null

# Build
echo -e "  ${DIM}Building...${NC}"
npm run build --silent 2>/dev/null

# Link globally
echo -e "  ${DIM}Linking CLI...${NC}"
npm link --silent 2>/dev/null

echo ""
echo -e "  ${GREEN}✓${NC} SwarmX installed successfully!"
echo ""
echo -e "  ${BOLD}Get started:${NC}"
echo -e "    ${CYAN}swarmx onboard${NC}        Interactive setup"
echo -e "    ${CYAN}swarmx init${NC}           Create a project"
echo -e "    ${CYAN}swarmx --help${NC}         Show all commands"
echo ""
