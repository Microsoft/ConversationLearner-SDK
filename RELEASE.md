# Release Process

This document outlines the process a developer would take to release a new version of @conversationlearner/sdk.

## Dependency Tree

In normal applications UI is generally the top level dependency the user interacts with; however, in this case @conversationlearner/ui is an actual npm package of the @conversationlearner/sdk.  This allows the SDK to provide every thing the developer needs to get started.

```
  converstionlearner-samples
      |
  @conversationlearner/sdk
      |    \
      |  @conversationlearner/ui
      |    /
  @conversationlearner/models
```

> Notice @conversationlearner/models is consumed by both the SDK and UI

# Self-contained changes
If the code changes to `@conversationlearner/sdk` do not require changes in `@conversationlearner/ui` or `@conversationlearner/models` then no special action is needed. Simply submit a PR and the merge will automatically publish a new version. Then update `converstionlearner-samples` to consume this new version.

# Cross-repo changes
In this case the code changes would require updates to @conversationlearner/models and/or @conversationlearner/ui.
In order to the changes without having to publish packages it is recommended to use [`npm link`](https://docs.npmjs.com/cli/link). This essentially points the dependency to another location on disk instead of an actual package which means you gets live updates as dependencies are re-built.

1. Get `link` chain setup, make necessary code changes across all repos, and test.

    (Since all the code changes are complete and tested the only thing left to do is use the actual npm packages instead of the locally linked versions)

2. Submit PR for changes in `@conversationlearner/models`
  
    > Note: When committing changes you should use the `npm run commit` command which will output a conventional commit message. This message is analyzed by the build to know which version to increment.

3. Merge PR to auto-publish new version of `@conversationlearner/models` based on changes.

4. Uptake new version of `@conversationlearner/models` in `@conversationlearner/ui` and `@conversationlearner/sdk`

5. Submit PR for changes in `@conversationlearner/ui`

6. Merge PR to auto-publish new version of `@conversationlearner/ui` based on changes.

7. Update new version of `@conversationlearner/ui` in `@conversationlearner/sdk`

8. Submit PR for changes in `@conversationlearner/sdk`

9. Merge PR to auto-publish new version of `@conversationlearner/sdk` based on changes.
  
10. Update new version of `@conversationlearner/sdk` in `conversationlearner-samples`

11. Submit PR for changes in `conversationlearner-samples`

12. Merge PR 

    (conversationlearner-samples is not an npm package; no publishing is required)

# Promoting packages to latest

`@conversationlearner/sdk` is the only package we expect consumers to use and by default it is published to the `next` tag to allow publishing releases of newer possibly breaking features without risking or disrupting current user workflow.

After it's determined that the particular version of the package is stable it can be promoted to the `latest` tag to become the default package installed by users.

To promote a package to latest tag:
```bash
npm dist-tag add @conversationlearner/sdk@0.126.0 latest
```

To view tags for a particular pacakge:
```bash
npm view @conversationlearner/sdk dist-tags
```

To view all published versions:
```bash
npm view @conversationlearner/sdk versions
```



