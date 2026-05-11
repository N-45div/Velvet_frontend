export type VelvetMeshLiveStatus = {
    programId: string;
    intentCount: number;
    acceptedMatchCount: number;
    settlementRouteCount: number;
    umbraWsolSupported: boolean;
    umbraSupportedMintCount: number;
    umbraRelayerReady: boolean;
    magicBlockRouterReady: boolean;
    magicBlockRouterSlot: number | null;
    magicBlockErHealthy: boolean;
    magicBlockErSlot: number | null;
    magicBlockCoreVersion: string | null;
    lastUpdatedAt: number;
};

export async function fetchVelvetMeshLiveStatus(): Promise<VelvetMeshLiveStatus> {
    const response = await fetch('/api/velvetmesh/status', {
        cache: 'no-store',
    });

    if (!response.ok) {
        throw new Error(`VelvetMesh status failed: ${response.status}`);
    }

    return response.json();
}
