#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN, Env,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProofRecord {
    pub id: u64,
    pub recipient: Address,
    pub incident_hash: BytesN<32>,
    pub claim_tx_hash: BytesN<32>,
    pub image_hash: BytesN<32>,
    pub issued_at: u64,
}

#[contractevent(topics = ["proof", "minted"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProofMinted {
    #[topic]
    pub id: u64,
    #[topic]
    pub recipient: Address,
    pub incident_hash: BytesN<32>,
    pub claim_tx_hash: BytesN<32>,
    pub image_hash: BytesN<32>,
    pub issued_at: u64,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    ImageHash,
    NextId,
    Proof(u64),
    Incident(BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ProofError {
    AlreadyMinted = 1,
}

#[contract]
pub struct ProofOfAid;

#[contractimpl]
impl ProofOfAid {
    pub fn __constructor(env: Env, admin: Address, image_hash: BytesN<32>) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::ImageHash, &image_hash);
        env.storage().instance().set(&DataKey::NextId, &1u64);
        env.storage()
            .instance()
            .extend_ttl(0, env.storage().max_ttl());
    }

    pub fn mint(
        env: Env,
        recipient: Address,
        incident_hash: BytesN<32>,
        claim_tx_hash: BytesN<32>,
    ) -> Result<ProofRecord, ProofError> {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        let incident_key = DataKey::Incident(incident_hash.clone());
        if env.storage().persistent().has(&incident_key) {
            return Err(ProofError::AlreadyMinted);
        }

        let id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap();
        let image_hash: BytesN<32> = env.storage().instance().get(&DataKey::ImageHash).unwrap();
        let issued_at = env.ledger().timestamp();
        let proof = ProofRecord {
            id,
            recipient: recipient.clone(),
            incident_hash: incident_hash.clone(),
            claim_tx_hash: claim_tx_hash.clone(),
            image_hash: image_hash.clone(),
            issued_at,
        };

        let proof_key = DataKey::Proof(id);
        let max_ttl = env.storage().max_ttl();
        env.storage().persistent().set(&proof_key, &proof);
        env.storage().persistent().set(&incident_key, &id);
        env.storage()
            .persistent()
            .extend_ttl(&proof_key, 0, max_ttl);
        env.storage()
            .persistent()
            .extend_ttl(&incident_key, 0, max_ttl);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));
        env.storage().instance().extend_ttl(0, max_ttl);
        ProofMinted {
            id,
            recipient,
            incident_hash,
            claim_tx_hash,
            image_hash,
            issued_at,
        }
        .publish(&env);

        Ok(proof)
    }

    pub fn get(env: Env, id: u64) -> Option<ProofRecord> {
        env.storage().persistent().get(&DataKey::Proof(id))
    }

    pub fn get_by_incident(env: Env, incident_hash: BytesN<32>) -> Option<ProofRecord> {
        let id: Option<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::Incident(incident_hash));
        id.and_then(|proof_id| env.storage().persistent().get(&DataKey::Proof(proof_id)))
    }

    pub fn count(env: Env) -> u64 {
        let next_id: u64 = env.storage().instance().get(&DataKey::NextId).unwrap();
        next_id - 1
    }

    pub fn image_hash(env: Env) -> BytesN<32> {
        env.storage().instance().get(&DataKey::ImageHash).unwrap()
    }
}

mod test;
