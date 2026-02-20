"""
Tests for the SwarmX Config Loader.
"""

from __future__ import annotations

import os
import tempfile
import pytest

from swarmx.utils.config import load_config, resolve_env_vars, build_engine_from_config


class TestConfigLoader:
    """Test suite for config loading."""

    def test_load_valid_yaml(self):
        """Should load a valid YAML config."""
        config_content = """
swarm:
  name: "Test Swarm"
  providers:
    mock:
      type: mock
      api_key: test-key
      model: test-model
  agents:
    test-agent:
      provider: mock
      subscriptions:
        - task.created
"""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as f:
            f.write(config_content)
            f.flush()
            config = load_config(f.name)

        assert config["swarm"]["name"] == "Test Swarm"
        assert "mock" in config["swarm"]["providers"]
        assert "test-agent" in config["swarm"]["agents"]

        os.unlink(f.name)

    def test_load_missing_file(self):
        """Should raise FileNotFoundError for missing file."""
        with pytest.raises(FileNotFoundError):
            load_config("/nonexistent/path.yaml")

    def test_resolve_env_vars(self):
        """Should resolve environment variable references."""
        os.environ["TEST_SWARMX_KEY"] = "resolved-value"
        result = resolve_env_vars("${TEST_SWARMX_KEY}")
        assert result == "resolved-value"
        del os.environ["TEST_SWARMX_KEY"]

    def test_resolve_env_vars_passthrough(self):
        """Non-env-var strings should pass through unchanged."""
        result = resolve_env_vars("plain-string")
        assert result == "plain-string"

    def test_resolve_missing_env_var(self):
        """Missing env vars should resolve to empty string."""
        result = resolve_env_vars("${DEFINITELY_NOT_SET_VAR}")
        assert result == ""
