/**
 * Range Protocol Compliance API Integration
 * https://docs.range.org/risk-api/risk-introduction
 * 
 * Provides sanctions screening and risk scoring for wallet addresses
 * before allowing confidential swaps.
 */

export type RiskLevel = 
    | "CRITICAL RISK (Directly malicious)"
    | "Extremely high risk"
    | "High risk"
    | "Medium risk"
    | "Low risk"
    | "Very low risk";

export interface MaliciousEvidence {
    address: string;
    distance: number;
    name_tag: string | null;
    entity: string | null;
    category: string;
}

export interface Attribution {
    name_tag: string;
    entity: string;
    category: string;
    address_role: string;
}

export interface AddressRiskResponse {
    riskScore: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
    riskLevel: RiskLevel;
    numHops: number;
    maliciousAddressesFound: MaliciousEvidence[];
    reasoning: string;
    attribution?: Attribution | null;
}

export interface ComplianceResult {
    isCompliant: boolean;
    riskScore: number;
    riskLevel: RiskLevel;
    reasoning: string;
    isSanctioned: boolean;
    maliciousConnections: MaliciousEvidence[];
    checkedAt: Date;
}

const RANGE_API_URL = 'https://api.range.org/v1/risk/address';
const RISK_THRESHOLD = 5; // Block swaps for risk score >= 5

/**
 * Check wallet address compliance using Range Protocol Risk API
 */
export async function checkAddressCompliance(
    address: string,
    apiKey?: string
): Promise<ComplianceResult> {
    // Use environment variable or passed API key
    const key = apiKey || process.env.NEXT_PUBLIC_RANGE_API_KEY;
    
    if (!key) {
        console.warn('Range API key not configured, skipping compliance check');
        return {
            isCompliant: true,
            riskScore: 1,
            riskLevel: "Very low risk",
            reasoning: "Compliance check skipped - no API key configured",
            isSanctioned: false,
            maliciousConnections: [],
            checkedAt: new Date(),
        };
    }

    try {
        const url = new URL(RANGE_API_URL);
        url.searchParams.append('address', address);
        url.searchParams.append('network', 'solana');

        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            throw new Error(`Range API error: ${response.status} ${response.statusText}`);
        }

        const data: AddressRiskResponse = await response.json();
        
        // Check for direct sanctions/blacklist
        const isSanctioned = data.maliciousAddressesFound.some(
            m => m.distance === 0 && (
                m.category === 'sanctions' || 
                m.category === 'hack_funds' ||
                m.category === 'terrorism_financing'
            )
        );

        return {
            isCompliant: data.riskScore < RISK_THRESHOLD && !isSanctioned,
            riskScore: data.riskScore,
            riskLevel: data.riskLevel,
            reasoning: data.reasoning,
            isSanctioned,
            maliciousConnections: data.maliciousAddressesFound,
            checkedAt: new Date(),
        };
    } catch (error) {
        console.error('Range compliance check failed:', error);
        // Fail open for demo purposes - in production, consider failing closed
        return {
            isCompliant: true,
            riskScore: 0,
            riskLevel: "Very low risk",
            reasoning: `Compliance check failed: ${error}`,
            isSanctioned: false,
            maliciousConnections: [],
            checkedAt: new Date(),
        };
    }
}

/**
 * Get risk badge color based on score
 */
export function getRiskBadgeColor(riskScore: number): string {
    if (riskScore <= 2) return 'bg-green-500';
    if (riskScore <= 4) return 'bg-yellow-500';
    if (riskScore <= 6) return 'bg-orange-500';
    return 'bg-red-500';
}

/**
 * Get risk badge text
 */
export function getRiskBadgeText(riskScore: number): string {
    if (riskScore <= 2) return 'Low Risk';
    if (riskScore <= 4) return 'Medium Risk';
    if (riskScore <= 6) return 'High Risk';
    return 'Critical Risk';
}

/**
 * Format compliance status for display
 */
export function formatComplianceStatus(result: ComplianceResult): {
    icon: string;
    text: string;
    color: string;
    description: string;
} {
    if (result.isSanctioned) {
        return {
            icon: '🚫',
            text: 'Sanctioned',
            color: 'text-red-500',
            description: 'This address appears on sanctions lists and cannot swap.',
        };
    }
    
    if (!result.isCompliant) {
        return {
            icon: '⚠️',
            text: 'High Risk',
            color: 'text-orange-500',
            description: `Risk score ${result.riskScore}/10 exceeds threshold. ${result.reasoning}`,
        };
    }

    return {
        icon: '✅',
        text: 'Compliant',
        color: 'text-green-500',
        description: `Risk score ${result.riskScore}/10. ${result.reasoning}`,
    };
}
