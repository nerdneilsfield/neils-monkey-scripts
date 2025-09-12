# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a collection of Tampermonkey userscripts organized by category. The repository contains 9 userscripts across 5 categories:

- **scholar/**: Academic paper exporters for IEEE, MDPI, Springer, and arXiv that convert papers to Markdown with metadata
- **code/**: GitHub file download utilities  
- **forum/**: Social platform enhancements (Zhihu)
- **video/**: Video download tools (yt-dlp integration)
- **nsfw/**: Content enhancement scripts

## Architecture

### Userscript Structure
Each `.user.js` file follows standard Tampermonkey format with:
- Userscript headers (`@name`, `@match`, `@require`, etc.)
- Configuration objects with feature flags and settings
- Main functionality wrapped in IIFE
- External library dependencies (JSZip, Turndown, etc.)

### Scholar Exporters Pattern
The academic paper exporters share common architecture:
- **Configuration**: Centralized config objects with feature flags, image processing settings, and export formats
- **Multiple Export Formats**: Markdown with links, Base64-embedded images, and TextBundle packages
- **Image Processing**: Advanced image conversion (GIF→PNG/WebP), size optimization, and quality control
- **Metadata Extraction**: Paper titles, authors, abstracts, and citation information
- **Error Handling**: Retry mechanisms, timeout handling, and graceful degradation

### Key Dependencies
- **JSZip**: For TextBundle package creation
- **Turndown**: HTML to Markdown conversion
- **GM_xmlhttpRequest**: Cross-domain requests
- **GM_download**: File downloads

## Development Commands

This repository has minimal build tooling:
```bash
# No specific build commands - userscripts are directly executable
# Testing is done by installing scripts in Tampermonkey and testing on target sites

# The only npm script available:
npm test  # Currently returns error - no tests configured
```

## Script Installation

Scripts include auto-update URLs pointing to the GitHub repository:
- `@downloadURL`: Direct installation link
- `@updateURL`: Update check endpoint

Each script is self-contained and can be installed individually in Tampermonkey.

## Configuration Patterns

Most scripts use centralized configuration objects with:
- Feature flags for different export modes
- Image processing parameters (quality, dimensions, formats)
- API endpoints and retry settings
- Debug and concurrency controls

## Development Guidelines

### Required Tools Usage
When working with this codebase, **ALWAYS** use these MCP tools:
- **context7**: For JavaScript/Tampermonkey API documentation and best practices
- **grep**: For searching code patterns across the repository (use literal code patterns, not keywords)

### Tampermonkey Script Requirements (2025 Standards)
Follow these mandatory practices:

#### Metadata Headers
- Include complete userscript headers with all required metadata
- Use semantic versioning in `@version` field
- Include specific `@match` patterns instead of broad `@include` wildcards
- Specify minimal required permissions with `@grant` directives
- Add `@connect` domains for all external requests
- Include `@downloadURL` and `@updateURL` for auto-updates
- Add `@antifeature` tags to disclose monetization (ads, tracking, mining)
- Use internationalization for `@name` and `@description` when appropriate

#### Security Best Practices
- Implement Subresource Integrity (SRI) for external resources: `@require https://cdn.example.com/lib.js#sha256=abc123...`
- Use `@sandbox JavaScript` when requiring unsafeWindow access
- Use `@sandbox DOM` for DOM-only operations (better performance)
- Avoid `@grant none` unless absolutely necessary

### JavaScript Performance Best Practices (2025)

#### Memory Management
- Use WeakMap/WeakSet for DOM element associations to prevent memory leaks
- Implement proper cleanup in beforeunload/unload events
- Clear intervals/timeouts when script terminates

#### Code Organization
- Wrap all code in IIFE with `'use strict'` to prevent global scope pollution
- Use const/let instead of var for better scoping and performance
- Implement proper error boundaries with try-catch blocks

#### Async Operations & Performance
- Use Promise.allSettled() for concurrent operations with error isolation
- Implement exponential backoff for retry mechanisms
- Use AbortController for cancellable async operations
- Set concurrency limits for image processing (CONFIG.IMG_CONCURRENCY)
- Implement timeouts for all network requests (CONFIG.FETCH_TIMEOUT_MS)

#### DOM Optimization
- Use event delegation instead of multiple event listeners
- Batch DOM updates to avoid layout thrashing
- Use passive event listeners where possible: `{ passive: true }`
- Cache DOM queries in variables instead of repeated selections

#### Context Selection
- Choose appropriate execution context:
  - `@run-at document-start` for early DOM manipulation
  - `@run-at document-end` for most use cases
  - `@run-at document-idle` for non-critical operations

### Code Structure Standards
- Use modern JavaScript features (ES2022+ syntax)
- Implement proper error handling with structured logging
- Use configuration objects for maintainable feature flags
- Employ Web Workers for CPU-intensive operations when possible
- Cache processed data to avoid redundant computations