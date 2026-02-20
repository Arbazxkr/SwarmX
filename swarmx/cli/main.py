"""
SwarmX CLI — Command-line interface for managing and running swarms.

Provides commands to:
  - Run a swarm from a YAML config
  - Submit tasks interactively
  - Check swarm status
  - Validate configurations
  - Initialize new swarm projects

Inspired by OpenClaw's CLI-first approach to agent management.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

import click
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from swarmx import __version__

console = Console()


# ── Helpers ─────────────────────────────────────────────────────

def _run_async(coro: Any) -> Any:
    """Run an async coroutine from sync CLI context."""
    return asyncio.run(coro)


def _print_banner() -> None:
    """Print the SwarmX banner."""
    banner = Text()
    banner.append("🐝 SwarmX", style="bold cyan")
    banner.append(f" v{__version__}", style="dim")
    banner.append(" — Multi-Agent Orchestration Framework", style="white")
    console.print(Panel(banner, border_style="cyan", padding=(0, 2)))


# ── CLI Group ───────────────────────────────────────────────────

@click.group()
@click.version_option(version=__version__, prog_name="SwarmX")
def cli() -> None:
    """🐝 SwarmX — Multi-Agent Orchestration Framework.

    A model-agnostic, async, event-driven framework for orchestrating
    multiple AI agents. CLI-first, local-first, developer-focused.
    """
    pass


# ── Run Command ─────────────────────────────────────────────────

@cli.command()
@click.argument("config_file", type=click.Path(exists=True))
@click.option("--task", "-t", help="Task to submit immediately after starting.")
@click.option("--interactive", "-i", is_flag=True, help="Enter interactive mode after starting.")
@click.option("--log-level", "-l", default="INFO", help="Log level (DEBUG, INFO, WARNING, ERROR).")
def run(config_file: str, task: str | None, interactive: bool, log_level: str) -> None:
    """Run a swarm from a YAML configuration file.

    Example:
        swarmx run swarm.yaml --task "Analyze the market"
        swarmx run swarm.yaml --interactive
    """
    _print_banner()

    from swarmx.utils.logging import setup_logging
    setup_logging(level=log_level)

    from swarmx.utils.config import load_and_build

    try:
        engine = load_and_build(config_file)
    except Exception as e:
        console.print(f"[red]Error loading config:[/red] {e}")
        sys.exit(1)

    async def _run() -> None:
        await engine.start()

        # Show status
        status = engine.status()
        _print_status_table(status)

        # Submit initial task if provided
        if task:
            console.print(f"\n[cyan]Submitting task:[/cyan] {task}")
            task_id = await engine.submit_task(task)
            console.print(f"[green]Task submitted:[/green] {task_id}")
            # Wait a bit for processing
            await asyncio.sleep(3)

        # Interactive mode
        if interactive or not task:
            await _interactive_loop(engine)

        await engine.stop()

    try:
        _run_async(_run())
    except KeyboardInterrupt:
        console.print("\n[yellow]Interrupted — shutting down...[/yellow]")


async def _interactive_loop(engine: Any) -> None:
    """Interactive REPL for submitting tasks to the swarm."""
    console.print(
        "\n[dim]Interactive mode. Type a task and press Enter. "
        "Commands: /status, /agents, /events, /quit[/dim]\n"
    )

    while True:
        try:
            user_input = await asyncio.get_event_loop().run_in_executor(
                None, lambda: input("🐝 > ")
            )
        except (EOFError, KeyboardInterrupt):
            console.print("\n[yellow]Exiting...[/yellow]")
            break

        user_input = user_input.strip()
        if not user_input:
            continue

        if user_input == "/quit":
            break
        elif user_input == "/status":
            _print_status_table(engine.status())
        elif user_input == "/agents":
            _print_agents_table(engine)
        elif user_input == "/events":
            _print_recent_events(engine)
        elif user_input.startswith("/"):
            console.print(f"[red]Unknown command:[/red] {user_input}")
        else:
            task_id = await engine.submit_task(user_input)
            console.print(f"[green]Task submitted:[/green] {task_id}")
            # Give agents time to process
            await asyncio.sleep(2)
            # Show latest agent responses
            recent = engine.event_bus.recent_events(5)
            for event in recent:
                if event.topic.startswith("agent.response"):
                    content = event.payload.get("content", "")
                    agent_id = event.payload.get("agent_id", "unknown")
                    console.print(f"\n[bold cyan]{agent_id}:[/bold cyan]")
                    console.print(content)


def _print_status_table(status: dict[str, Any]) -> None:
    """Print a formatted status table."""
    table = Table(title="SwarmX Status", border_style="cyan")
    table.add_column("Component", style="bold")
    table.add_column("Details")

    table.add_row("Running", "✅ Yes" if status["running"] else "❌ No")
    table.add_row("Agents", str(len(status.get("agents", {}))))
    table.add_row("Providers", ", ".join(status.get("providers", [])))

    bus_stats = status.get("event_bus", {})
    table.add_row(
        "Events",
        f"Published: {bus_stats.get('published', 0)} | "
        f"Dispatched: {bus_stats.get('dispatched', 0)} | "
        f"Errors: {bus_stats.get('errors', 0)}",
    )

    sched = status.get("scheduler", {})
    table.add_row(
        "Scheduler",
        f"Pending: {sched.get('pending', 0)} | Running: {sched.get('running', 0)}",
    )

    console.print(table)


def _print_agents_table(engine: Any) -> None:
    """Print agent details."""
    table = Table(title="Agents", border_style="cyan")
    table.add_column("ID", style="bold")
    table.add_column("Name")
    table.add_column("Provider")
    table.add_column("State")

    for agent_id, agent in engine.agents.items():
        table.add_row(
            agent_id,
            agent.config.name,
            agent.config.provider,
            agent.state.value,
        )

    console.print(table)


def _print_recent_events(engine: Any) -> None:
    """Print recent events."""
    events = engine.event_bus.recent_events(10)
    if not events:
        console.print("[dim]No events recorded yet.[/dim]")
        return

    table = Table(title="Recent Events", border_style="cyan")
    table.add_column("ID", style="dim")
    table.add_column("Topic", style="bold")
    table.add_column("Source")
    table.add_column("Payload")

    for event in events:
        payload_str = str(event.payload)[:60] + "..." if len(str(event.payload)) > 60 else str(event.payload)
        table.add_row(event.event_id, event.topic, event.source, payload_str)

    console.print(table)


# ── Validate Command ────────────────────────────────────────────

@cli.command()
@click.argument("config_file", type=click.Path(exists=True))
def validate(config_file: str) -> None:
    """Validate a swarm configuration file.

    Example:
        swarmx validate swarm.yaml
    """
    from swarmx.utils.config import load_config

    try:
        config = load_config(config_file)
        swarm = config.get("swarm", config)

        # Check required sections
        issues = []
        if "providers" not in swarm:
            issues.append("Missing 'providers' section")
        if "agents" not in swarm:
            issues.append("Missing 'agents' section")

        # Check agent-provider bindings
        providers = set(swarm.get("providers", {}).keys())
        for agent_name, agent_def in swarm.get("agents", {}).items():
            provider = agent_def.get("provider", "")
            if provider and provider not in providers:
                issues.append(
                    f"Agent '{agent_name}' references unknown provider '{provider}'"
                )

        if issues:
            console.print("[red]Validation issues:[/red]")
            for issue in issues:
                console.print(f"  ❌ {issue}")
            sys.exit(1)
        else:
            console.print("[green]✅ Configuration is valid![/green]")
            console.print(f"  Providers: {len(providers)}")
            console.print(f"  Agents: {len(swarm.get('agents', {}))}")

    except Exception as e:
        console.print(f"[red]Error:[/red] {e}")
        sys.exit(1)


# ── Init Command ────────────────────────────────────────────────

@cli.command()
@click.option("--name", "-n", default="my-swarm", help="Swarm project name.")
@click.option("--provider", "-p", default="openai", help="Default provider (openai, anthropic, google, xai).")
def init(name: str, provider: str) -> None:
    """Initialize a new SwarmX project with a sample config.

    Example:
        swarmx init --name my-research-swarm --provider anthropic
    """
    _print_banner()

    config_path = Path(f"{name}.yaml")
    if config_path.exists():
        console.print(f"[yellow]Warning:[/yellow] {config_path} already exists. Overwrite? ", end="")
        if input("[y/N] ").lower() != "y":
            return

    # Generate env var name
    provider_env = {
        "openai": "OPENAI_API_KEY",
        "anthropic": "ANTHROPIC_API_KEY",
        "google": "GOOGLE_API_KEY",
        "xai": "XAI_API_KEY",
    }
    env_var = provider_env.get(provider, f"{provider.upper()}_API_KEY")

    # Default models
    provider_models = {
        "openai": "gpt-4o",
        "anthropic": "claude-sonnet-4-20250514",
        "google": "gemini-2.0-flash",
        "xai": "grok-2-latest",
    }
    model = provider_models.get(provider, "")

    config_content = f"""# SwarmX Configuration — {name}
# Docs: https://github.com/swarmx/swarmx

swarm:
  name: "{name}"

  providers:
    {provider}:
      type: {provider}
      api_key: ${{{env_var}}}
      model: {model}
      temperature: 0.7
      max_tokens: 4096

  agents:
    coordinator:
      provider: {provider}
      system_prompt: |
        You are the coordinator agent. You receive tasks, break them down,
        and coordinate with other agents to accomplish goals. Be concise
        and structured in your responses.
      subscriptions:
        - task.created
        - agent.response.*

    researcher:
      provider: {provider}
      system_prompt: |
        You are a research agent. You analyze information, find patterns,
        and provide detailed insights. Focus on accuracy and depth.
      subscriptions:
        - research.*
        - task.created

    writer:
      provider: {provider}
      system_prompt: |
        You are a writing agent. You take research and analysis and
        produce clear, well-structured output. Focus on clarity and
        readability.
      subscriptions:
        - writing.*
"""

    config_path.write_text(config_content)
    console.print(f"[green]✅ Created:[/green] {config_path}")
    console.print(f"\n[dim]Set your API key:[/dim]")
    console.print(f"  export {env_var}=your-key-here")
    console.print(f"\n[dim]Run your swarm:[/dim]")
    console.print(f"  swarmx run {config_path} --interactive")


# ── Status Command ──────────────────────────────────────────────

@cli.command()
@click.argument("config_file", type=click.Path(exists=True))
def status(config_file: str) -> None:
    """Show the status of a swarm configuration.

    Example:
        swarmx status swarm.yaml
    """
    from swarmx.utils.config import load_config

    config = load_config(config_file)
    swarm = config.get("swarm", config)

    # Display swarm info
    console.print(f"\n[bold cyan]Swarm:[/bold cyan] {swarm.get('name', 'unnamed')}")

    # Providers
    providers = swarm.get("providers", {})
    table = Table(title="Providers", border_style="cyan")
    table.add_column("Name", style="bold")
    table.add_column("Type")
    table.add_column("Model")

    for name, pdef in providers.items():
        table.add_row(name, pdef.get("type", name), pdef.get("model", "default"))

    console.print(table)

    # Agents
    agents = swarm.get("agents", {})
    table = Table(title="Agents", border_style="cyan")
    table.add_column("Name", style="bold")
    table.add_column("Provider")
    table.add_column("Subscriptions")

    for name, adef in agents.items():
        subs = ", ".join(adef.get("subscriptions", []))
        table.add_row(name, adef.get("provider", ""), subs)

    console.print(table)


# ── Entry Point ─────────────────────────────────────────────────

if __name__ == "__main__":
    cli()
