import { useEffect, useState } from "react";
import { api } from "../../utils/Admin/api/api";

interface Voter {
  _id: string;
  VoterId: string;
  name: string;
  email: string;
  constituency: string;
  contact: string;
  Address: string;
  createdAt: string;
}

export default function Voters() {
  const [voters, setVoters] = useState<Voter[]>([]);
  const [loading, setLoading] = useState(false);

  const [search, setSearch] = useState("");

  const [page, setPage] = useState(1);
  const [limit] = useState(10);
  const [totalPages, setTotalPages] = useState(1);

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    constituency: "Bengaluru",
    contact: "",
    Address: "",
  });

  const fetchVoters = async () => {
    try {
      setLoading(true);

      const res = await api.get("/admin/voters", {
        params: {
          page,
          limit,
          search,
        },
      });

      setVoters(res.data.data);
      setTotalPages(res.data.pagination.totalPages);
    } catch (err) {
      console.log(err);
      alert("Failed to fetch voters");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVoters();
  }, [page, search]);

  const resetForm = () => {
    setEditingId(null);

    setForm({
      name: "",
      email: "",
      password: "",
      constituency: "Bengaluru",
      contact: "",
      Address: "",
    });
  };

  const openCreate = () => {
    resetForm();
    setShowModal(true);
  };

  const openEdit = (voter: Voter) => {
    setEditingId(voter._id);

    setForm({
      name: voter.name,
      email: voter.email,
      password: "",
      contact: voter.contact,
      Address: voter.Address,
      constituency: voter.constituency,
    });

    setShowModal(true);
  };

  const submitForm = async () => {
    try {
      if (!form.name || !form.email || !form.constituency) {
        return alert("Fill required fields");
      }

      if (editingId) {
        await api.put(`/admin/voters/${editingId}`, form);
      } else {
        await api.post("/admin/voters/", form);
      }

      setShowModal(false);
      resetForm();
      fetchVoters();
    } catch (err: any) {
      alert(err.response?.data?.message || "Operation failed");
    }
  };

  const deleteVoter = async (id: string) => {
    if (!window.confirm("Delete voter?")) return;

    try {
      await api.delete(`/admin/voters/${id}`);
      fetchVoters();
    } catch {
      alert("Delete failed");
    }
  };

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Voters</h1>

        <button
          onClick={openCreate}
          className="bg-blue-600 text-white px-5 py-2 rounded-lg"
        >
          Add Voter
        </button>
      </div>

      <div className="mb-5">
        <input
          className="border rounded-lg px-4 py-2 w-80"
          placeholder="Search..."
          value={search}
          onChange={(e) => {
            setPage(1);
            setSearch(e.target.value);
          }}
        />
      </div>

      <div className="overflow-x-auto bg-white rounded-xl shadow">
        <table className="w-full">
          <thead className="bg-slate-100">
            <tr>
              <th className="p-3 text-left">Voter ID</th>
              <th className="p-3 text-left">Name</th>
              <th className="p-3 text-left">Email</th>
              <th className="p-3 text-left">Constituency</th>
              <th className="p-3 text-left">Contact</th>
              <th className="p-3 text-left">Address</th>
              <th className="p-3 text-center">Actions</th>
            </tr>
          </thead>

          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="text-center p-10">
                  Loading...
                </td>
              </tr>
            )}

            {!loading &&
              voters.map((voter) => (
                <tr key={voter._id} className="border-t">
                  <td className="p-3">{voter.VoterId}</td>

                  <td className="p-3">{voter.name}</td>

                  <td className="p-3">{voter.email}</td>

                  <td className="p-3">{voter.constituency}</td>

                  <td className="p-3">{voter.Address}</td>

                  <td className="p-3 text-center space-x-2">
                    <button
                      onClick={() => openEdit(voter)}
                      className="bg-yellow-500 text-white px-3 py-1 rounded"
                    >
                      Edit
                    </button>

                    <button
                      onClick={() => deleteVoter(voter._id)}
                      className="bg-red-600 text-white px-3 py-1 rounded"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            {!loading && voters.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center p-10 text-slate-500">
                  No voters found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}

      <div className="flex items-center justify-between mt-6">
        <button
          disabled={page === 1}
          onClick={() => setPage((p) => p - 1)}
          className="px-4 py-2 rounded bg-slate-200 disabled:opacity-50"
        >
          Previous
        </button>

        <p className="font-medium">
          Page {page} / {totalPages}
        </p>

        <button
          disabled={page === totalPages}
          onClick={() => setPage((p) => p + 1)}
          className="px-4 py-2 rounded bg-slate-200 disabled:opacity-50"
        >
          Next
        </button>
      </div>

      {/* Modal */}

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex justify-center items-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6">
            <h2 className="text-2xl font-bold mb-5">
              {editingId ? "Edit Voter" : "Add Voter"}
            </h2>

            <div className="space-y-4">
              <input
                placeholder="Name"
                value={form.name}
                onChange={(e) =>
                  setForm({
                    ...form,
                    name: e.target.value,
                  })
                }
                className="w-full border rounded-lg px-4 py-2"
              />

              <input
                placeholder="Email"
                type="email"
                value={form.email}
                onChange={(e) =>
                  setForm({
                    ...form,
                    email: e.target.value,
                  })
                }
                className="w-full border rounded-lg px-4 py-2"
              />

              <input
                placeholder="Password"
                type="password"
                value={form.password}
                onChange={(e) =>
                  setForm({
                    ...form,
                    password: e.target.value,
                  })
                }
                className="w-full border rounded-lg px-4 py-2"
              />

              <select
                value={form.constituency}
                onChange={(e) =>
                  setForm({
                    ...form,
                    constituency: e.target.value,
                  })
                }
                className="w-full border rounded-lg px-4 py-2"
              >
                <option value="Bengaluru">Bengaluru</option>
                <option value="Delhi">Delhi</option>
                <option value="Mumbai">Mumbai</option>
              </select>

              <input
                placeholder="Contact"
                value={form.contact}
                onChange={(e) =>
                  setForm({
                    ...form,
                    contact: e.target.value,
                  })
                }
                className="w-full border rounded-lg px-4 py-2"
              />

              <textarea
                placeholder="Address"
                value={form.Address}
                onChange={(e) =>
                  setForm({
                    ...form,
                    Address: e.target.value,
                  })
                }
                rows={3}
                className="w-full border rounded-lg px-4 py-2 resize-none"
              />
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => {
                  setShowModal(false);
                  resetForm();
                }}
                className="px-5 py-2 rounded-lg bg-slate-200"
              >
                Cancel
              </button>

              <button
                onClick={submitForm}
                className="px-5 py-2 rounded-lg bg-blue-600 text-white"
              >
                {editingId ? "Update" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
