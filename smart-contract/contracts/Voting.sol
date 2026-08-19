// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Voting {
    struct Vote {
        uint candidateId;
        bytes32 receipt;
    }

    struct Candidate {
        uint id;
        string name;
        string constituency;
        uint voteCount;
    }

    mapping(bytes32 => bool) public usedReceipts;
    mapping(uint => Candidate) public candidates;

    // Constituency data
    mapping(string => uint) public constituencyCandidateCount;
    mapping(string => bool) private constituencyExists;
    string[] private constituencies;

    uint public candidateCount;

    event VoteCast(bytes32 receipt);

    function addCandidate(
        string memory _name,
        string memory _constituency
    ) public {
        candidateCount++;

        candidates[candidateCount] = Candidate({
            id: candidateCount,
            name: _name,
            constituency: _constituency,
            voteCount: 0
        });

        constituencyCandidateCount[_constituency]++;

        if (!constituencyExists[_constituency]) {
            constituencyExists[_constituency] = true;
            constituencies.push(_constituency);
        }
    }

    function getConstituencies() public view returns (string[] memory) {
        return constituencies;
    }

    function vote(uint _candidateId, bytes32 _receipt) public {
        require(!usedReceipts[_receipt], "Already voted");
        require(
            _candidateId > 0 && _candidateId <= candidateCount,
            "Invalid candidate"
        );

        candidates[_candidateId].voteCount++;
        usedReceipts[_receipt] = true;

        emit VoteCast(_receipt);
    }

    function verifyVote(bytes32 _receipt) public view returns (bool) {
        return usedReceipts[_receipt];
    }

    function getCandidate(
        uint _id
    ) public view returns (string memory, string memory, uint) {
        require(_id > 0 && _id <= candidateCount, "Invalid candidate");

        Candidate memory c = candidates[_id];

        return (c.name, c.constituency, c.voteCount);
    }
}
