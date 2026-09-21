export function useRouter() {
  return {
    replace: (url: string) => window.location.assign(url),
    refresh: () => window.location.reload(),
  };
}
