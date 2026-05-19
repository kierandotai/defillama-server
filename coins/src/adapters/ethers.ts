
import providers from "@defillama/sdk/build/providers.json";

export {providers}

export const chainIdMap: { [id: number]: string } = {};
Object.keys(providers).map((c: string) => {
  chainIdMap[(providers[c as keyof typeof providers] as any).chainId] = c;
});
