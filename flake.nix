{
  description = "Nix packages and Home Manager modules for agent tooling: oh-my-pi (OMP) and its extensions, GSD, Paseo and its plugins, SearXNG";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";
    latest.url = "github:nixos/nixpkgs/nixpkgs-unstable";

    flake-parts = {
      url = "github:hercules-ci/flake-parts";
      inputs.nixpkgs-lib.follows = "nixpkgs";
    };

    # omp, spec-kit, openspec.
    llm-agents = {
      url = "github:numtide/llm-agents.nix";
      inputs = {
        nixpkgs.follows = "latest";
        flake-parts.follows = "flake-parts";
      };
    };

    # Fork of getpaseo/paseo: an upstream release tag plus local-only OMP patches (custom messages
    # as replies, discoverable host tools) and open upstream PRs, listed in FORK.md on the `local`
    # branch; see AGENTS.md.
    paseo = {
      url = "github:truelecter/paseo/local";
      inputs.nixpkgs.follows = "latest";
    };
  };

  outputs = inputs @ {flake-parts, ...}:
    flake-parts.lib.mkFlake {inherit inputs;} ({lib, ...}: let
      mkPaseo = system: inputs.paseo.packages.${system}.default;

      importLatest = system:
        import inputs.latest {
          inherit system;
          config.allowUnfree = true;
        };

      mkPackages = pkgs: rec {
        gsd-omp = pkgs.callPackage ./packages/gsd-omp {};
        # Pins a workspace in the local Paseo daemon's sidebar (no CLI or MCP command for it).
        paseo-pin-workspace = pkgs.callPackage ./packages/paseo-pin-workspace {};
        omp-extensions = import ./omp-extensions {
          inherit (pkgs) lib stdenvNoCC runCommand bun;
          inherit gsd-omp;
        };
        paseo-plugins = import ./paseo-plugins {
          inherit (pkgs) lib stdenvNoCC bun curl esbuild fetchurl jq writeShellApplication;
          # Plugins are checked against the pinned Paseo (requirements.paseo).
          paseoVersion = (mkPaseo pkgs.stdenv.hostPlatform.system).version;
        };
      };
    in {
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];

      perSystem = {system, ...}: let
        # The bun.lock format needs a recent Bun, so Bun comes from `latest`.
        pkgs = import inputs.nixpkgs {
          inherit system;
          config.allowUnfree = true;
          overlays = [(_final: _prev: {inherit (importLatest system) bun;})];
        };
        packages = mkPackages pkgs;
      in {
        _module.args.pkgs = pkgs;

        packages =
          {
            inherit (packages) gsd-omp paseo-pin-workspace;
            # Paseo's daemon and headless Chromium against every plugin; runs on Linux and macOS.
            paseo-plugins-e2e = pkgs.callPackage ./paseo-plugins/_e2e {
              paseo = mkPaseo system;
              plugins = packages.paseo-plugins;
            };
          }
          // lib.mapAttrs' (name: lib.nameValuePair "omp-extension-${name}") packages.omp-extensions
          // lib.mapAttrs' (name: lib.nameValuePair "paseo-plugin-${name}") packages.paseo-plugins;

        formatter = pkgs.alejandra;
      };

      flake = {
        overlays.default = final: _prev: let
          inherit (final.stdenv.hostPlatform) system;
          latest = importLatest system;
        in
          {
            inherit
              (latest)
              searxng
              ;

            paseo = mkPaseo system;

            # Metro transforms the generated validator `@getpaseo/protocol`
            # `dist/generated/validation/ws-outbound.aot.js` (about 12 MB) in one
            # worker, which needs more than 2 GB of heap. Node's default heap limit
            # (V8's old generation) is half the machine's memory, at most 2 GB, or
            # 4 GB with 15 GB of memory or more. So 4096 MB is V8's own ceiling: it
            # changes nothing on bigger builders and lifts the 2 GB limit of a 7 GB
            # GitHub macOS runner, where the worker ran out of memory.
            #
            # `bin/paseo` is the CLI the app bundles: on macOS the app's own shim, which follows the
            # link back into the bundle and runs the CLI through the app's Electron; on Linux the CLI
            # bin the Electron launcher uses, whose shebang the install points at Nix's node.
            paseo-desktop =
              (inputs.paseo.packages.${system}.desktop.override {
                inherit (final) paseo;
              }).overrideAttrs (old: {
                env = old.env // {NODE_OPTIONS = "--max-old-space-size=4096";};
                postInstall =
                  (old.postInstall or "")
                  + (
                    if final.stdenv.hostPlatform.isDarwin
                    then ''
                      ln -s ../Applications/Paseo.app/Contents/Resources/bin/paseo "$out/bin/paseo"
                    ''
                    else ''
                      ln -s ../share/paseo-desktop/packages/cli/bin/paseo "$out/bin/paseo"
                    ''
                  )
                  + ''
                    test -x "$out/bin/paseo"
                  '';
              });

            # The install check's `omp --smoke-test` fails in the Darwin sandbox
            # ("Port 0 is in use") when it starts the stats server.
            omp = inputs.llm-agents.packages.${system}.omp.overrideAttrs {
              doInstallCheck = false;
            };

            inherit
              (inputs.llm-agents.packages.${system})
              spec-kit
              openspec
              ;
          }
          // (mkPackages final);

        homeModules = {
          oh-my-pi = ./homeModules/oh-my-pi.nix;
          paseo = ./homeModules/paseo.nix;
          searxng = ./homeModules/searxng.nix;
        };
      };
    });
}
