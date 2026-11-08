# ai.nix

Nix packages and Home Manager modules for agent tooling: [oh-my-pi](https://github.com/can1357/oh-my-pi) (`omp`) with its extensions and GSD, [Paseo](https://github.com/getpaseo/paseo) with its plugins, and a local SearXNG for OMP's web search.

## What's in it

| Path                          | What it is                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `homeModules/oh-my-pi.nix`    | `programs.oh-my-pi`: OMP's settings overlay, extensions, rules, skills, agents, hooks, MCP servers                          |
| `homeModules/paseo.nix`       | `programs.paseo`: the Paseo app and CLI, the daemon's `~/.paseo/config.json`, plugins, `paseo-plugin-dev`                   |
| `homeModules/searxng.nix`     | `services.searxng`: SearXNG as a user service (launchd on macOS, systemd on Linux)                                          |
| `omp-extensions/`             | OMP extensions, one per folder (`aws-profile`, `caveman`, `gsd`, `hide-denied-tools`, `mcp-ready`, `paseo-tools`, `say`, ...) |
| `paseo-plugins/`              | Paseo plugins, one per folder (`backlog`, `beautiful-chat`, `project-groups`, `wide-chat`, ...), and their end-to-end suite |
| `packages/gsd-omp/`           | the gsd-omp CLI, built from the `truelecter/gsd-omp` fork                                                                   |
| `packages/paseo-pin-workspace/` | `paseo-pin-workspace`: pins a workspace in the local Paseo daemon's sidebar                                               |

Each extension and plugin has its own `README.md`.

## Use it

```nix
{
  inputs.ai = {
    url = "github:truelecter/ai.nix";
    # Optional: build with your own pins instead of this flake's.
    inputs.nixpkgs.follows = "nixpkgs";
  };

  # nixpkgs.overlays = [inputs.ai.overlays.default];
  # home-manager.sharedModules = builtins.attrValues inputs.ai.homeModules;
}
```

Then, in a Home Manager configuration:

```nix
{pkgs, ...}: {
  programs.oh-my-pi = {
    enable = true;
    extensions = with pkgs.omp-extensions; [mcp-ready paseo-tools say gsd];
  };

  programs.paseo = {
    enable = true;
    desktop.enable = true;
    plugins = {
      backlog = {};
      wide-chat = {};
    };
  };
}
```

`overlays.default` provides `pkgs.omp`, `pkgs.paseo`, `pkgs.paseo-desktop`, `pkgs.omp-extensions.<name>`, `pkgs.paseo-plugins.<id>`, `pkgs.gsd-omp`, `pkgs.paseo-pin-workspace`, `pkgs.searxng`, `pkgs.spec-kit`, and `pkgs.openspec`; the modules' package defaults read them. The packages build with the consumer's nixpkgs, whose `bun` must be recent enough for the `bun.lock` files (nixpkgs-unstable's is).

The same packages are flake outputs: `nix build .#omp-extension-<name>`, `.#paseo-plugin-<id>`, `.#gsd-omp`, `.#paseo-pin-workspace`, and `nix run .#paseo-plugins-e2e` for the plugins' end-to-end suite.

## Develop

[`AGENTS.md`](AGENTS.md) describes how the modules work, how to build and test an extension or plugin, how to try a plugin in a running Paseo without a switch, and the end-to-end suite. CI runs that suite on every change to the plugins or the lock, and updates `flake.lock` weekly.

## License

MIT, see [`COPYING`](COPYING).
