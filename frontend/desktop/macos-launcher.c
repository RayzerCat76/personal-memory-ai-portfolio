#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/utsname.h>
#include <unistd.h>

int main(void) {
  char executable[PATH_MAX];
  uint32_t size = sizeof(executable);
  if (_NSGetExecutablePath(executable, &size) != 0) return 1;
  char resolved[PATH_MAX];
  if (!realpath(executable, resolved)) return 1;

  char base[PATH_MAX];
  strncpy(base, resolved, sizeof(base) - 1);
  base[sizeof(base) - 1] = '\0';
  char *macos = dirname(base);
  char root[PATH_MAX];
  snprintf(root, sizeof(root), "%s/../../..", macos);
  char rootResolved[PATH_MAX];
  if (!realpath(root, rootResolved)) return 1;

  struct utsname info;
  if (uname(&info) != 0) return 1;
  const char *runtime = strcmp(info.machine, "arm64") == 0 ? "macos-arm64/bin/node" : "macos-x64/bin/node";

  char node[PATH_MAX], launcher[PATH_MAX];
  snprintf(node, sizeof(node), "%s/runtime/%s", rootResolved, runtime);
  snprintf(launcher, sizeof(launcher), "%s/launcher.mjs", rootResolved);
  execl(node, node, launcher, (char *)NULL);
  return 1;
}
