#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};

fn setup() -> (Env, ProofOfAidClient<'static>, Address, BytesN<32>) {
    let env = Env::default();
    let admin = Address::generate(&env);
    let image_hash = BytesN::from_array(&env, &[9; 32]);
    let contract_id = env.register(ProofOfAid, (admin.clone(), image_hash.clone()));
    let client = ProofOfAidClient::new(&env, &contract_id);
    (env, client, admin, image_hash)
}

#[test]
fn mint_stores_unique_proof_and_requests_admin_auth() {
    let (env, client, admin, image_hash) = setup();
    let recipient = Address::generate(&env);
    let incident_hash = BytesN::from_array(&env, &[1; 32]);
    let claim_tx_hash = BytesN::from_array(&env, &[2; 32]);
    env.mock_all_auths();

    let proof = client.mint(&recipient, &incident_hash, &claim_tx_hash);

    assert_eq!(env.auths().len(), 1);
    assert_eq!(env.auths()[0].0, admin);
    assert_eq!(proof.id, 1);
    assert_eq!(proof.recipient, recipient);
    assert_eq!(proof.incident_hash, incident_hash);
    assert_eq!(proof.claim_tx_hash, claim_tx_hash);
    assert_eq!(proof.image_hash, image_hash);
    assert_eq!(client.count(), 1);
    assert_eq!(client.get(&1), Some(proof.clone()));
    assert_eq!(client.get_by_incident(&incident_hash), Some(proof));
}

#[test]
fn rejects_second_mint_for_same_incident() {
    let (env, client, _, _) = setup();
    let recipient = Address::generate(&env);
    let incident_hash = BytesN::from_array(&env, &[3; 32]);
    let first_claim = BytesN::from_array(&env, &[4; 32]);
    let second_claim = BytesN::from_array(&env, &[5; 32]);
    env.mock_all_auths();

    client.mint(&recipient, &incident_hash, &first_claim);
    let duplicate = client.try_mint(&recipient, &incident_hash, &second_claim);

    assert_eq!(duplicate, Err(Ok(ProofError::AlreadyMinted)));
    assert_eq!(client.count(), 1);
}

#[test]
fn exposes_the_fixed_local_image_hash() {
    let (_, client, _, image_hash) = setup();

    assert_eq!(client.image_hash(), image_hash);
}
